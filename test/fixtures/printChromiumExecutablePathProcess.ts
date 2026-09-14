import { loadChromium } from '../../src/authentication/browserLogin.js';

const [browsersDirectory] = process.argv.slice(2);

/* Настоящий импорт playwright: вычисляется только путь, Chromium не запускается и не скачивается */
const chromium = await loadChromium(browsersDirectory);
process.stdout.write(chromium.executablePath());
