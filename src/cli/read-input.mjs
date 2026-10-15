import { EXIT_USAGE } from '../core/exit-codes.mjs';
import { readFailure, readRegularText } from '../core/safe-read.mjs';
import { red } from '../core/terminal.mjs';

export function readInputFile(file, shown = file, maxBytes = undefined) {
  try {
    return readRegularText(file, maxBytes);
  } catch (error) {
    console.error(`${red('✗')} ${shown} could not be read (${readFailure(error)}).`);
    return process.exit(EXIT_USAGE);
  }
}
