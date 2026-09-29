import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	// 压缩后的 base64 体积上限。Default: DEFAULT_MAX_BYTES
	maxBytes?: number;
	// 触发压缩的阈值，按原图字节数计；不超过它的图片直接原样返回，不重新编码。
	// Default: DEFAULT_COMPRESS_ABOVE_BYTES
	compressAboveBytes?: number;
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 质量下限。再低档位对截图文字的伪影已很明显，宁可继续缩小尺寸也不再降质。
const MIN_JPEG_QUALITY = 70;

// 压缩目标：base64 体积压到该值以内。质量不够就降分辨率，不降质。
export const DEFAULT_MAX_BYTES = 150 * 1024;

// 触发阈值：原图字节数不超过它就原样返回，不做任何重新编码。单位是原图字节，
// 与 maxBytes 的 base64 口径不同。
export const DEFAULT_COMPRESS_ABOVE_BYTES = 200 * 1024;

export const IMAGE_COMPRESS_ABOVE_CHOICES = [
	{ label: "200 KB (default)", bytes: 200 * 1024 },
	{ label: "100 KB", bytes: 100 * 1024 },
	{ label: "300 KB", bytes: 300 * 1024 },
	{ label: "500 KB", bytes: 500 * 1024 },
	{ label: "1 MB", bytes: 1024 * 1024 },
] as const;

export function formatImageCompressAboveBytes(bytes: number): string {
	const choice = IMAGE_COMPRESS_ABOVE_CHOICES.find((item) => item.bytes === bytes);
	return choice ? choice.label : `${Math.round(bytes / 1024)} KB`;
}

export function parseImageCompressAboveBytes(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return undefined;
		const choice = IMAGE_COMPRESS_ABOVE_CHOICES.find((item) => item.label === trimmed);
		if (choice) return choice.bytes;
		const parsed = Number(trimmed);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return undefined;
}

export const IMAGE_MAX_BYTES_CHOICES = [
	{ label: "150 KB (default)", maxBytes: 150 * 1024 },
	{ label: "100 KB", maxBytes: 100 * 1024 },
	{ label: "200 KB", maxBytes: 200 * 1024 },
	{ label: "300 KB", maxBytes: 300 * 1024 },
	{ label: "500 KB", maxBytes: 500 * 1024 },
	{ label: "1 MB", maxBytes: 1024 * 1024 },
	{ label: "2 MB", maxBytes: 2 * 1024 * 1024 },
	{ label: "4.5 MB (lossless PNG preferred)", maxBytes: 4.5 * 1024 * 1024 },
] as const;

export function formatImageMaxBytes(maxBytes: number): string {
	const choice = IMAGE_MAX_BYTES_CHOICES.find((item) => item.maxBytes === maxBytes);
	if (choice) {
		return choice.label;
	}
	return `${Math.round(maxBytes / 1024)} KB`;
}

export function parseImageMaxBytes(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return undefined;
		}
		const choice = IMAGE_MAX_BYTES_CHOICES.find((item) => item.label === trimmed);
		if (choice) {
			return choice.maxBytes;
		}
		const parsed = Number(trimmed);
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return undefined;
}

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	compressAboveBytes: DEFAULT_COMPRESS_ABOVE_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	// 逐项覆盖而非直接展开，否则调用方传入 { maxBytes: undefined } 会把缺省值
	// 覆盖成 undefined，导致预算比较失效。
	const opts: Required<ImageResizeOptions> = { ...DEFAULT_OPTIONS };
	for (const [key, value] of Object.entries(options ?? {})) {
		if (value !== undefined) {
			(opts as Record<string, unknown>)[key] = value;
		}
	}

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
		// 尺寸限制内且原图不超过触发阈值时直接原样返回，避免对本来就很小的图
		// 做无意义的重新编码。阈值比的是原图字节，与 maxBytes 的 base64 口径不同。
		if (
			originalWidth <= opts.maxWidth &&
			originalHeight <= opts.maxHeight &&
			inputBytes.byteLength <= opts.compressAboveBytes
		) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		const qualitySteps = Array.from(new Set([Math.max(opts.jpegQuality, MIN_JPEG_QUALITY), 85, MIN_JPEG_QUALITY]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			const fitting = candidates.find((candidate) => candidate.encodedSize < opts.maxBytes);
			if (fitting) {
				// photon 的 PNG 编码器可能比原文件更大（实测 1920x1080 截图 +30%）。
				// 尺寸没变时若重编码反而不划算，就退回原图，否则预算放宽时每张图都会变大。
				const dimensionsUnchanged = currentWidth === originalWidth && currentHeight === originalHeight;
				if (dimensionsUnchanged && fitting.encodedSize >= inputBase64Size) {
					return {
						data: Buffer.from(inputBytes).toString("base64"),
						mimeType: mimeType || `image/${format}`,
						originalWidth,
						originalHeight,
						width: originalWidth,
						height: originalHeight,
						wasResized: false,
					};
				}
				return {
					data: fitting.data,
					mimeType: fitting.mimeType,
					originalWidth,
					originalHeight,
					width: currentWidth,
					height: currentHeight,
					wasResized: true,
				};
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
