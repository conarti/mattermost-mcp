/**
 * Конфигурация semantic-release. Порядок плагинов фиксирован намеренно:
 * commit-analyzer определяет тип бампа из сообщений коммитов, затем
 * release-notes-generator и changelog готовят текст и файл, затем npm записывает
 * версию и публикует пакет, затем github публикует релиз с заметками, и последним
 * git возвращает изменённые файлы в репозиторий. Если поставить git раньше npm,
 * в коммит уйдёт package.json со старой версией. Версии плагинов те же, что в
 * clouds-messenger-mcp, сверены с реестром npm:
 * semantic-release 25.0.9, @semantic-release/commit-analyzer 13.0.1,
 * @semantic-release/release-notes-generator 14.1.1, @semantic-release/changelog 7.0.0,
 * @semantic-release/npm 13.1.5, @semantic-release/github 12.0.9,
 * @semantic-release/git 11.0.1.
 *
 * Явного конфига не требует ни один плагин: changelog пишет CHANGELOG.md в корне,
 * npm публикует пакет из корня (поле `files: ["build"]` в package.json уже ограничивает
 * содержимое тарбола, поэтому `pkgRoot` не переопределяем), git по умолчанию коммитит
 * CHANGELOG.md, package.json и package-lock.json сообщением
 * `chore(release): <версия> [skip ci]`. Метка [skip ci] не даёт релизному коммиту
 * заново запустить workflow и уйти в цикл.
 *
 * Пакет уже на ветке 1.x, поэтому правило major zero (breaking -> minor) не нужно:
 * ломающее изменение штатно выпускает следующий MAJOR.
 *
 * Ручной шаг перед первым релизом (делается один раз, при выпуске, не при подготовке).
 * В репозитории нет тегов, а без тега semantic-release считает историю пустой и
 * выпускает 1.0.0, которая уже занята в npm. Базовый тег ставится на коммит 3c6dd0d,
 * из которого опубликована последняя версия 1.1.2:
 *   git tag v1.1.2 3c6dd0d && git push origin v1.1.2
 * После этого первый прогон увидит после тега feat-коммит и посчитает 1.2.0. Версия
 * 1.2.0 в package.json уже записана вручную, это не мешает: npm version вызывается
 * с --allow-same-version.
 */
export default {
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm',
    '@semantic-release/github',
    '@semantic-release/git',
  ],
};
