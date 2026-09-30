import { FileInfo, Post } from "../types.js";

export interface FormattedFile {
  id: string;
  name: string;
  extension: string;
  size: number;
  mime_type: string;
  width?: number;
  height?: number;
}

export interface FormattedPostAttachments {
  file_ids?: string[];
  files?: FormattedFile[];
}

export function formatFile(file: FileInfo): FormattedFile {
  return {
    id: file.id,
    name: file.name,
    extension: file.extension,
    size: file.size,
    mime_type: file.mime_type,
    ...(file.width === undefined ? {} : { width: file.width }),
    ...(file.height === undefined ? {} : { height: file.height }),
  };
}

/** У постов без вложений ключей file_ids и files нет, чтобы вывод не рос */
export function formatPostAttachments(post: Post): FormattedPostAttachments {
  const attachments: FormattedPostAttachments = {};
  if (post.file_ids && post.file_ids.length > 0) {
    attachments.file_ids = post.file_ids;
  }
  const files = post.metadata?.files;
  if (files && files.length > 0) {
    attachments.files = files.map(formatFile);
  }
  return attachments;
}
