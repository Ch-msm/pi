# 模型目录维护

普通构建只编译已纳入版本控制的模型目录，不访问模型目录接口，也不自动更新生成文件。已安装依赖后，可在仓库根目录直接构建：

```bash
npm run build
```

需要更新模型目录时，在仓库根目录显式执行：

```bash
npm --prefix packages/ai run generate-models
npm --prefix packages/ai run generate-image-models
```

这两个命令需要联网，分别更新：

- `packages/ai/src/models.generated.ts`
- `packages/ai/src/image-models.generated.ts`

模型目录更新应作为独立变更审查，重点检查模型删除、API 协议、兼容参数、价格和上下文限制，并验证相关测试。不要直接编辑生成文件；需要修正规则时修改对应生成器，再重新生成。

审查完成后运行 `npm run check` 和 `npm run build`。发布脚本仍会显式更新模型目录；普通构建与打包不再隐式触发更新。
