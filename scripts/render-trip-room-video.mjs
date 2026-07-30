import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  prepareValidatedRepositoryOutput,
  readValidatedRenderManifest,
  validateCheckedOutRepositoryFile,
  validatePendingRenderManifest,
  validateRenderOutputBytes,
  validateRenderSceneSource
} from "./trip-room-render-paths.mjs";

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

class RenderFailure extends Error {}

function fail(message) {
  throw new RenderFailure(message);
}

function safeText(value, fallback = "") {
  return String(value || fallback).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

function ffmpegText(value) {
  return safeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

function manifestError(error) {
  return error instanceof RenderFailure
    ? safeText(error.message, "The render did not complete.")
    : "The render did not complete.";
}

function validateOutputSize(bytes) {
  try {
    validateRenderOutputBytes(bytes);
  } catch {
    fail("Output media exceeds the 95 MiB render boundary");
  }
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => rejectRun(new RenderFailure("FFmpeg could not start the render")));
    child.on("exit", (code) => code === 0
      ? resolveRun()
      : rejectRun(new RenderFailure("FFmpeg could not complete the render")));
  });
}

async function validateSceneFiles({ manifest, repository, branch, rootPath }) {
  const validated = [];
  for (const scene of manifest.scenes) {
    if (!scene?.sourceUrl || !["image", "video"].includes(scene.kind)) {
      fail("Manifest contains an invalid scene");
    }
    let source;
    try {
      source = validateRenderSceneSource({
        sourceUrl: scene.sourceUrl,
        bookingId: manifest.bookingId,
        repository,
        branch,
        rootPath
      });
    } catch {
      fail("Manifest contains an invalid scene source");
    }
    let checkedOut;
    try {
      checkedOut = await validateCheckedOutRepositoryFile({
        rootPath,
        relativePath: source.sourcePath,
        label: "scene source"
      });
    } catch {
      fail("Manifest contains an invalid checked-out scene source");
    }
    if (checkedOut.size > MAX_SOURCE_BYTES) {
      fail("Source media exceeds the 30 MB render boundary");
    }
    validated.push({ ...scene, ...source, sourceFile: checkedOut.absolutePath });
  }
  return validated;
}

async function renderScene(scene, index, workdir) {
  const duration = Math.max(0.5, Math.min(Number(scene.durationSeconds || 1.6), 5));
  const extension = extname(scene.sourcePath) || (scene.kind === "video" ? ".mp4" : ".jpg");
  const output = join(workdir, `scene-${String(index).padStart(2, "0")}${extension}.mp4`);
  const common = [
    "-t", String(duration),
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p",
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "30", "-y", output
  ];
  if (scene.kind === "video") {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-stream_loop", "-1", "-i", scene.sourceFile, ...common]);
  } else {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-loop", "1", "-i", scene.sourceFile, ...common]);
  }
  return output;
}

async function renderOutro(manifest, workdir) {
  const duration = Math.max(1, Math.min(Number(manifest.outroSeconds || 2), 5));
  const output = join(workdir, "scene-outro.mp4");
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const regularFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const boatName = ffmpegText(manifest.boatName || "Your Cove charter");
  const location = ffmpegText(manifest.locationName || "Lake of the Ozarks");
  const filter = [
    `drawtext=fontfile='${font}':text='COVE CHARTERS':fontcolor=white:fontsize=62:x=(w-text_w)/2:y=690`,
    `drawtext=fontfile='${font}':text='${boatName}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=835`,
    `drawtext=fontfile='${regularFont}':text='${location}':fontcolor=0xF3D9AE:fontsize=36:x=(w-text_w)/2:y=920`,
    `drawtext=fontfile='${regularFont}':text='CoveCharters.com':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=1100`
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-f", "lavfi",
    "-i", `color=c=0x071D2B:s=1080x1920:r=30:d=${duration}`,
    "-vf", filter, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "22",
    "-pix_fmt", "yuv420p", "-r", "30", "-t", String(duration), "-y", output
  ]);
  return output;
}

export async function copyValidatedRenderOutput({
  renderedOutput,
  outputPath,
  rootPath = process.cwd()
}) {
  validateOutputSize((await stat(renderedOutput)).size);
  const target = await prepareValidatedRepositoryOutput({
    rootPath,
    relativePath: outputPath
  });
  try {
    await copyFile(renderedOutput, target.absolutePath, constants.COPYFILE_EXCL);
  } catch {
    fail("Invalid Trip Room output path");
  }
  const checkedOut = await validateCheckedOutRepositoryFile({
    rootPath,
    relativePath: target.relativePath,
    label: "output path"
  });
  validateOutputSize(checkedOut.size);
  return checkedOut.absolutePath;
}

async function render({ manifest, paths, repository, branch, rootPath }) {
  const scenes = await validateSceneFiles({ manifest, repository, branch, rootPath });
  const workdir = join(tmpdir(), `cove-${paths.renderId}`);
  await mkdir(workdir, { recursive: true });
  const segments = [];
  for (const [index, scene] of scenes.entries()) {
    segments.push(await renderScene(scene, index, workdir));
  }
  segments.push(await renderOutro(manifest, workdir));

  const concatList = join(workdir, "concat.txt");
  await writeFile(concatList, segments.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"));
  const videoOnly = join(workdir, "video-only.mp4");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-f", "concat", "-safe", "0", "-i", concatList,
    "-c", "copy", "-y", videoOnly
  ]);

  const renderedOutput = join(workdir, "render-output.mp4");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-i", videoOnly,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-shortest", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", "-y", renderedOutput
  ]);
  validateOutputSize((await stat(renderedOutput)).size);

  await copyValidatedRenderOutput({
    renderedOutput,
    outputPath: paths.outputPath,
    rootPath
  });

  manifest.status = "completed";
  manifest.completedAt = new Date().toISOString();
  manifest.error = null;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/render-trip-room-video.mjs <manifest.json>");
    process.exitCode = 2;
    return;
  }

  let manifest;
  let paths;
  try {
    const validatedManifest = await readValidatedRenderManifest({
      manifestPath,
      rootPath: process.cwd()
    });
    manifest = validatedManifest.manifest;
    paths = validatePendingRenderManifest({
      manifestPath: validatedManifest.paths.manifestPath,
      manifest,
      rootPath: process.cwd()
    });
  } catch {
    console.error("Render manifest is not an eligible pending render.");
    process.exitCode = 2;
    return;
  }

  try {
    await render({
      manifest,
      paths,
      repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.GITHUB_REF_NAME,
      rootPath: process.cwd()
    });
  } catch (error) {
    manifest.status = "failed";
    manifest.completedAt = new Date().toISOString();
    manifest.error = manifestError(error);
    process.exitCode = 1;
  } finally {
    await writeFile(paths.manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  }

  console.log(JSON.stringify({
    renderId: paths.renderId,
    status: manifest.status,
    output: manifest.status === "completed" ? paths.outputPath : null,
    manifest: basename(paths.manifestPath)
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
