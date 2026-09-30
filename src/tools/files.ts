import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { MattermostClient, MattermostRequestError } from "../client.js";
import { DownloadFileArgs, FileInfo, GetFileInfoArgs } from "../types.js";
import { isValidMattermostId } from "./mattermostId.js";
import { formatFile } from "./postFormatting.js";

export const DOWNLOAD_DIRECTORY_NAME = "mattermost-mcp";
export const PARTIAL_FILE_SUFFIX = ".part";
export const INLINE_IMAGE_MAX_BYTES = 1024 * 1024;
/** Только растровые форматы: SVG и редкие типы клиенты MCP отвергают */
export const INLINE_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const INVALID_FILE_ID_MESSAGE = "Invalid file_id: expected a 26-character Mattermost id";
export const INLINE_SKIPPED_SIZE_REASON = "Inline skipped: file is larger than 1 MB";

const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const FILE_NOT_FOUND_ERROR_CODE = "ENOENT";
const HOME_DIRECTORY_SHORTCUT = "~";
const HOME_DIRECTORY_PREFIXES = ["~/", "~\\"];
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const TRAILING_SEPARATORS_PATTERN = /[\\/]+$/;
const NAMES_OUTSIDE_DIRECTORY = ["", ".", ".."];

export function createInlineSkippedTypeReason(mimeType: string): string {
  return `Inline skipped: ${mimeType} is not one of ${INLINE_IMAGE_MIME_TYPES.join(", ")}`;
}

export function createFileNotFoundMessage(fileId: string): string {
  return `File ${fileId} not found or not accessible`;
}

export function createFileForbiddenMessage(fileId: string): string {
  return `No permission to access file ${fileId}`;
}

export interface DownloadFileDependencies {
  temporaryDirectory: string;
  homeDirectory: string;
  cwd: string;
}

export type InlineImageDecision = { inline: true } | { inline: false; reason: string };

export interface DownloadTargetOptions {
  outputPath?: string;
  fileInfo: Pick<FileInfo, "id" | "name">;
  temporaryDirectory: string;
  homeDirectory: string;
  cwd: string;
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
}

export const getFileInfoTool: Tool = {
  name: "mattermost_get_file_info",
  description: "Get metadata of a file attached to a Mattermost post: name, extension, size, MIME type, image width and height, post ID. File IDs come from file_ids and files in channel history and thread replies.",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "The ID of the file (26 characters)",
      },
    },
    required: ["file_id"],
  },
};

export const downloadFileTool: Tool = {
  name: "mattermost_download_file",
  description: "Download a file attached to a Mattermost post to the local disk and return its absolute path and metadata. Without output_path the file is saved to the system temporary directory as mattermost-mcp/{file_id}_{name}. An existing file at the target path is overwritten. With inline=true a PNG, JPEG, GIF or WebP image up to 1 MB is also returned as image content; for other types or larger files the response explains why inline was skipped.",
  inputSchema: {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "The ID of the file (26 characters)",
      },
      output_path: {
        type: "string",
        description: "Where to save the file. An existing directory or a path ending with / or \\ is a directory: the file is saved inside it with its original name and missing directories are created. Any other path is the file path, missing parent directories are created. A leading ~ is expanded to the home directory, relative paths are resolved from the server working directory.",
      },
      inline: {
        type: "boolean",
        description: "If true, also return the image as image content when it is image/png, image/jpeg, image/gif or image/webp and not larger than 1 MB",
        default: false,
      },
    },
    required: ["file_id"],
  },
};

/** Имя с сервера сводится к basename, чтобы не выйти из папки назначения */
export function sanitizeFileName(name: string, fallback: string): string {
  const baseName = name.split(PATH_SEPARATOR_PATTERN).pop() ?? "";
  return NAMES_OUTSIDE_DIRECTORY.includes(baseName) ? fallback : baseName;
}

/** Раскрывается только ведущая ~ текущего пользователя, ~user остаётся как есть */
export function expandHomeDirectory(outputPath: string, homeDirectory: string): string {
  if (outputPath === HOME_DIRECTORY_SHORTCUT) {
    return homeDirectory;
  }
  const prefix = HOME_DIRECTORY_PREFIXES.find((homePrefix) => outputPath.startsWith(homePrefix));
  if (prefix === undefined) {
    return outputPath;
  }
  return join(homeDirectory, outputPath.slice(prefix.length));
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export async function resolveDownloadTarget(options: DownloadTargetOptions): Promise<string> {
  const { outputPath, fileInfo, temporaryDirectory, homeDirectory, cwd, stat: statPath = stat } = options;
  const fileName = sanitizeFileName(fileInfo.name, fileInfo.id);

  if (outputPath === undefined || outputPath === "") {
    return resolve(temporaryDirectory, DOWNLOAD_DIRECTORY_NAME, `${fileInfo.id}_${fileName}`);
  }

  const expandedPath = expandHomeDirectory(outputPath, homeDirectory);
  if (TRAILING_SEPARATORS_PATTERN.test(expandedPath)) {
    const directoryPath = expandedPath.replace(TRAILING_SEPARATORS_PATTERN, "");
    return join(resolve(cwd, directoryPath === "" ? expandedPath : directoryPath), fileName);
  }

  const absolutePath = resolve(cwd, expandedPath);
  try {
    const stats = await statPath(absolutePath);
    return stats.isDirectory() ? join(absolutePath, fileName) : absolutePath;
  } catch (error) {
    if (isErrorWithCode(error, FILE_NOT_FOUND_ERROR_CODE)) {
      return absolutePath;
    }
    throw error;
  }
}

export function decideInlineImage(mimeType: string, byteLength: number): InlineImageDecision {
  if (!INLINE_IMAGE_MIME_TYPES.includes(mimeType)) {
    return { inline: false, reason: createInlineSkippedTypeReason(mimeType) };
  }
  if (byteLength > INLINE_IMAGE_MAX_BYTES) {
    return { inline: false, reason: INLINE_SKIPPED_SIZE_REASON };
  }
  return { inline: true };
}

function describeFileError(error: unknown, fileId: string): string {
  if (error instanceof MattermostRequestError) {
    if (error.status === HTTP_STATUS_NOT_FOUND) {
      return createFileNotFoundMessage(fileId);
    }
    if (error.status === HTTP_STATUS_FORBIDDEN) {
      return createFileForbiddenMessage(fileId);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function createErrorResult(message: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: message,
        }),
      },
    ],
    isError: true,
  };
}

export async function handleGetFileInfo(
  client: MattermostClient,
  args: GetFileInfoArgs
) {
  const { file_id } = args;
  if (!isValidMattermostId(file_id)) {
    return createErrorResult(INVALID_FILE_ID_MESSAGE);
  }

  try {
    const fileInfo = await client.getFileInfo(file_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...formatFile(fileInfo),
            ...(fileInfo.post_id ? { post_id: fileInfo.post_id } : {}),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("Error getting file info:", error);
    return createErrorResult(describeFileError(error, file_id));
  }
}

export async function handleDownloadFile(
  client: MattermostClient,
  args: DownloadFileArgs,
  dependencies: DownloadFileDependencies = {
    temporaryDirectory: tmpdir(),
    homeDirectory: homedir(),
    cwd: process.cwd(),
  }
) {
  const { file_id, output_path, inline = false } = args;
  if (!isValidMattermostId(file_id)) {
    return createErrorResult(INVALID_FILE_ID_MESSAGE);
  }

  let partialPath: string | undefined;
  try {
    const fileInfo = await client.getFileInfo(file_id);
    let inlineDecision = inline ? decideInlineImage(fileInfo.mime_type, fileInfo.size) : undefined;
    const targetPath = await resolveDownloadTarget({ outputPath: output_path, fileInfo, ...dependencies });
    await mkdir(dirname(targetPath), { recursive: true });

    /* Запись во временный файл и rename: при сбое старый файл по тому же пути не тронут, параллельные загрузки не пересекаются */
    partialPath = `${targetPath}.${process.pid}.${randomUUID()}${PARTIAL_FILE_SUFFIX}`;
    const body = await client.downloadFile(file_id);
    await pipeline(body, createWriteStream(partialPath));
    await rename(partialPath, targetPath);
    partialPath = undefined;

    let imageData: string | undefined;
    if (inlineDecision?.inline) {
      const fileContent = await readFile(targetPath);
      if (fileContent.byteLength > INLINE_IMAGE_MAX_BYTES) {
        inlineDecision = { inline: false, reason: INLINE_SKIPPED_SIZE_REASON };
      } else {
        imageData = fileContent.toString("base64");
      }
    }

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      {
        type: "text",
        text: JSON.stringify({
          path: targetPath,
          id: fileInfo.id,
          name: fileInfo.name,
          size: fileInfo.size,
          mime_type: fileInfo.mime_type,
          ...(inlineDecision && !inlineDecision.inline ? { inline_skipped_reason: inlineDecision.reason } : {}),
        }, null, 2),
      },
    ];
    if (imageData !== undefined) {
      content.push({ type: "image", data: imageData, mimeType: fileInfo.mime_type });
    }

    return { content };
  } catch (error) {
    if (partialPath !== undefined) {
      await rm(partialPath, { force: true });
    }
    console.error("Error downloading file:", error);
    return createErrorResult(describeFileError(error, file_id));
  }
}
