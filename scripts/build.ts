import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { spawn } from "node:child_process";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const external = [
  "electron",
  "@huggingface/transformers",
  "onnxruntime-node",
  "vm2",
  "sqlite3",
  "better-sqlite3",
  "sharp",
  "mysql",
  "mysql2",
  "pg",
  "pg-query-stream",
  "oracledb",
  "tedious",
  "mssql",
];

// 后端服务打包配置
const appBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: `data/serve/app.js`,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

// Electron 主进程打包配置
const mainBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["scripts/main.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  outfile: `build/main.js`,
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

function buildWorkflows(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["nitro", "build"], { stdio: "inherit", shell: false });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`nitro build exited ${code}`))));
    proc.on("error", reject);
  });
}

const workflowsOnly = process.argv.includes("--workflows-only");

(async () => {
  try {
    console.log("🔨 开始构建...\n");

    // Workflow bundle first — its discovery scans the source tree, so we
    // must remove any stale esbuild output. Otherwise nitro tries to bundle
    // data/serve/app.js as a workflow file and chokes on "module" / "tedious"
    // / "mysql" etc. that it can't resolve.
    console.log("🔧 构建 workflow runtime (nitro)...");
    for (const stale of ["data/serve/app.js", "build/main.js", ".output"]) {
      fs.rmSync(path.resolve(stale), { recursive: true, force: true });
    }
    await buildWorkflows();
    console.log("✅ Workflow runtime 构建完成: .output/server/index.mjs\n");

    if (workflowsOnly) {
      console.log("\n🎉 workflow runtime 单独构建完成!\n");
      return;
    }

    console.log("🔧 构建后端服务 + Electron 主进程 (esbuild)...");
    await Promise.all([esbuild.build(appBuildConfig), esbuild.build(mainBuildConfig)]);
    console.log("✅ 后端服务构建完成: data/serve/app.js");
    console.log("✅ Electron主进程构建完成: build/main.js");

    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
