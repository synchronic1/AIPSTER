/* Built with Meta Muse. */
// Hidden password entry for operator scripts: echoes * per keystroke, never
// the password. Streams are injectable so the masking behavior is testable.
export async function promptPassword(text, { input = process.stdin, output = process.stdout } = {}) {
  if (!input || input.isTTY !== true || typeof input.setRawMode !== 'function') {
    throw new Error('Interactive password entry requires a TTY; set D1_PASSWORD instead.');
  }
  output.write(text);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let pw = '';
    const done = (value, err) => {
      try { input.setRawMode(false); } catch { /* best effort */ }
      try { input.pause(); } catch { /* best effort */ }
      input.removeListener('data', onData);
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\n' || ch === '\r') return done(pw);
        if (ch === '\u0003') return done('', new Error('Password entry aborted.'));
        if (ch === '\u007f' || ch === '\b') {
          if (pw.length) { pw = pw.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        pw += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
  });
}
