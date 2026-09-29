/**
 * 两档图片体积策略的测试：
 *   - 原图字节小于 compressAboveBytes → 原样返回，不重新编码（保持无损）
 *   - 超过该阈值 → 重新编码压到 maxBytes 以内（base64 口径），质量不低于 q70
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPRESS_ABOVE_BYTES,
	DEFAULT_MAX_BYTES,
	formatImageCompressAboveBytes,
	formatImageMaxBytes,
	IMAGE_COMPRESS_ABOVE_CHOICES,
	IMAGE_MAX_BYTES_CHOICES,
	parseImageCompressAboveBytes,
	parseImageMaxBytes,
	resizeImageInProcess,
} from "../src/utils/image-resize-core.ts";

const TRIGGER = DEFAULT_COMPRESS_ABOVE_BYTES;
const BUDGET = DEFAULT_MAX_BYTES;

/**
 * 造一张体积可预测的 PNG：填确定性伪随机噪声，DEFLATE 压不动，
 * 因此编码体积基本由像素数决定，便于稳定地卡阈值。
 */
function makeNoisyPng(targetBytes: number): Uint8Array {
	const side = Math.ceil(Math.sqrt(targetBytes / 3)) + 1;
	const raw = Buffer.alloc(side * (1 + side * 3));
	let seed = 12345;
	for (let y = 0; y < side; y++) {
		const rowStart = y * (1 + side * 3);
		raw[rowStart] = 0; // filter: none
		for (let i = 1; i <= side * 3; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			raw[rowStart + i] = (seed >> 16) & 0xff;
		}
	}

	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc32 = (buf: Buffer): number => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(side, 0);
	ihdr.writeUInt32BE(side, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw, { level: 0 })),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

/** 约 120KB，低于 200KB 触发线。 */
const SMALL_PNG = makeNoisyPng(120_000);
/** 约 400KB，高于触发线。 */
const BIG_PNG = makeNoisyPng(400_000);

const smallBytes = SMALL_PNG.length;
const bigBytes = BIG_PNG.length;

describe("缺省阈值", () => {
	it("与文档一致", () => {
		expect(BUDGET).toBe(150 * 1024);
		expect(TRIGGER).toBe(200 * 1024);
	});

	it("触发阈值按原始字节、预算按 base64，故触发值更大", () => {
		// base64 约为原始字节的 4/3，两个阈值口径不同。
		expect(TRIGGER).toBeGreaterThan(BUDGET);
	});
});

describe("触发阈值按原图字节判定", () => {
	it("低于阈值的图原样返回，字节完全一致", async () => {
		expect(smallBytes).toBeLessThan(TRIGGER);

		const result = await resizeImageInProcess(SMALL_PNG, "image/png");
		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.mimeType).toBe("image/png");
		expect(Buffer.from(result!.data, "base64").equals(Buffer.from(SMALL_PNG))).toBe(true);
	});

	it("低于阈值时即便超出压缩预算也不动它", async () => {
		// 该图 base64 已超过 150KB 预算，但原图未达 200KB 触发线，必须保持原样。
		expect(Math.ceil(smallBytes / 3) * 4).toBeGreaterThan(BUDGET);
		expect(smallBytes).toBeLessThan(TRIGGER);

		const result = await resizeImageInProcess(SMALL_PNG, "image/png", { maxBytes: 10 * 1024 });
		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
	});

	it("高于阈值的图压到预算以内并转成 JPEG", async () => {
		expect(bigBytes).toBeGreaterThan(TRIGGER);

		const result = await resizeImageInProcess(BIG_PNG, "image/png");
		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(true);
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.data.length).toBeLessThan(BUDGET);
	});

	it("显式 compressAboveBytes 可覆盖触发线", async () => {
		const untouched = await resizeImageInProcess(SMALL_PNG, "image/png");
		const forced = await resizeImageInProcess(SMALL_PNG, "image/png", { compressAboveBytes: 1 });
		expect(untouched!.wasResized).toBe(false);
		expect(forced!.wasResized).toBe(true);
	});

	it("边界为严格大于：等于阈值走原样，多一字节即压缩", async () => {
		const atThreshold = await resizeImageInProcess(SMALL_PNG, "image/png", {
			compressAboveBytes: smallBytes,
		});
		const overThreshold = await resizeImageInProcess(SMALL_PNG, "image/png", {
			compressAboveBytes: smallBytes - 1,
		});
		expect(atThreshold!.wasResized).toBe(false);
		expect(overThreshold!.wasResized).toBe(true);
	});

	it("阈值口径是原图字节，不是 base64", async () => {
		// 同一张图，仅改变阈值口径的解读就会得到不同结果：按原图字节算是超标的。
		const result = await resizeImageInProcess(SMALL_PNG, "image/png", {
			compressAboveBytes: smallBytes,
			maxBytes: 10 * 1024,
		});
		expect(result!.wasResized).toBe(false);
	});
});

describe("质量下限 q70", () => {
	it("预算极小时持续降分辨率，放不下才返回 null", async () => {
		const impossible = await resizeImageInProcess(BIG_PNG, "image/png", { maxBytes: 1 });
		expect(impossible).toBeNull();

		const shrunk = await resizeImageInProcess(BIG_PNG, "image/png", { maxBytes: 20 * 1024 });
		expect(shrunk).not.toBeNull();
		expect(shrunk!.mimeType).toBe("image/jpeg");
		expect(shrunk!.data.length).toBeLessThan(20 * 1024);
	});

	it("调用方传入更低的 jpegQuality 会被抬到下限", async () => {
		// 下限 q70 生效时，指定 q40 与指定 q70 走完全相同的阶梯，结果应逐字节一致。
		const belowFloor = await resizeImageInProcess(BIG_PNG, "image/png", {
			maxBytes: 30 * 1024,
			jpegQuality: 40,
		});
		const atFloor = await resizeImageInProcess(BIG_PNG, "image/png", {
			maxBytes: 30 * 1024,
			jpegQuality: 70,
		});
		expect(belowFloor).not.toBeNull();
		expect(atFloor).not.toBeNull();
		expect(belowFloor!.data).toBe(atFloor!.data);
		expect(belowFloor!.width).toBe(atFloor!.width);
		expect(belowFloor!.height).toBe(atFloor!.height);
	});
	it("预算比触发线宽松时不得把图改大", async () => {
		// 回归：越过触发线后曾无条件重编码，而 photon 的 PNG 编码器可能比原图更大
		// （实测 1920x1080 截图 +30%）。预算一旦放宽到 1MB/4.5MB，每张图都会变大。
		for (const maxBytes of [1024 * 1024, 4.5 * 1024 * 1024]) {
			const result = await resizeImageInProcess(SMALL_PNG, "image/png", {
				compressAboveBytes: 1,
				maxBytes,
			});
			expect(result).not.toBeNull();
			// 结果要么退回原图，要么确实更小，不允许变大。
			const outSize = Math.floor((result!.data.length * 3) / 4);
			expect(outSize).toBeLessThanOrEqual(smallBytes);
		}
	});

	it("尺寸超限时仍必须缩放，不能因变大而退回原图", async () => {
		// SMALL_PNG 是 224x224，改用超尺寸限制的组合验证另一条分支。
		const result = await resizeImageInProcess(SMALL_PNG, "image/png", {
			maxWidth: 8,
			maxHeight: 8,
			compressAboveBytes: 1,
			maxBytes: 4.5 * 1024 * 1024,
		});
		expect(result).not.toBeNull();
		expect(result!.width).toBeLessThanOrEqual(8);
		expect(result!.height).toBeLessThanOrEqual(8);
	});
});

describe("选项合并", () => {
	it("显式 undefined 不会覆盖缺省值", async () => {
		const undef = await resizeImageInProcess(BIG_PNG, "image/png", {
			maxBytes: undefined,
			compressAboveBytes: undefined,
		});
		const none = await resizeImageInProcess(BIG_PNG, "image/png");
		expect(undef!.wasResized).toBe(none!.wasResized);
		expect(undef!.data).toBe(none!.data);
	});
});

describe("设置项取值", () => {
	it("maxBytes 各档往返一致", () => {
		for (const choice of IMAGE_MAX_BYTES_CHOICES) {
			expect(formatImageMaxBytes(choice.maxBytes)).toBe(choice.label);
			expect(parseImageMaxBytes(choice.label)).toBe(choice.maxBytes);
		}
		expect(parseImageMaxBytes(IMAGE_MAX_BYTES_CHOICES[0].label)).toBe(DEFAULT_MAX_BYTES);
	});

	it("compressAboveBytes 各档往返一致", () => {
		for (const choice of IMAGE_COMPRESS_ABOVE_CHOICES) {
			expect(formatImageCompressAboveBytes(choice.bytes)).toBe(choice.label);
			expect(parseImageCompressAboveBytes(choice.label)).toBe(choice.bytes);
		}
		expect(parseImageCompressAboveBytes(IMAGE_COMPRESS_ABOVE_CHOICES[0].label)).toBe(DEFAULT_COMPRESS_ABOVE_BYTES);
	});

	it("拒绝非法值", () => {
		expect(parseImageMaxBytes("")).toBeUndefined();
		expect(parseImageMaxBytes("nonsense")).toBeUndefined();
		expect(parseImageMaxBytes(0)).toBeUndefined();
		expect(parseImageMaxBytes(-5)).toBeUndefined();
		expect(parseImageCompressAboveBytes("")).toBeUndefined();
		expect(parseImageCompressAboveBytes(-1)).toBeUndefined();
	});

	it("未知值回退为 KB 展示", () => {
		expect(formatImageMaxBytes(123 * 1024)).toBe("123 KB");
		expect(formatImageCompressAboveBytes(456 * 1024)).toBe("456 KB");
	});
});
