// node:sqlite prints an ExperimentalWarning on Node 22; it is stable enough for this use, so hide just that one.
const orig = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (orig as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
