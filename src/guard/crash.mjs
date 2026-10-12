import { envFlag, resolveAgentFlag } from './options.mjs';

export function strictOnCrash(run, refuse, what) {
  return async (flags) => {
    try {
      return await run(flags);
    } catch (error) {
      if (envFlag('SHOMRA_GUARD_STRICT')) {
        const message = error instanceof Error ? error.message : String(error);
        refuse(resolveAgentFlag(flags), `Shomra ${what} failed (${message.slice(0, 200)}); blocked by fail-closed policy.`);
      }
      throw error;
    }
  };
}
