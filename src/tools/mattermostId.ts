/** Идентификатор Mattermost: 26 символов из строчных латинских букв и цифр */
export const MATTERMOST_ID_PATTERN = /^[a-z0-9]{26}$/;

/** Проверка до запроса: id попадает в URL и в имя файла по умолчанию */
export function isValidMattermostId(id: unknown): id is string {
  return typeof id === "string" && MATTERMOST_ID_PATTERN.test(id);
}
