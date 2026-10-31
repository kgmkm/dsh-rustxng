/**
 * Agent-facing tools.
 *
 * The seam provider (lib/web-provider.js) replaces `web_search`; these tools exist so
 * the model can also reach RustXNG directly with the options the seam does not expose
 * (engine shortcut, category, time range, language) and can diagnose the instance.
 */
import { readLive } from './rustxng-client.js';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Read the settings fields the status report shows.
 *
 * Once the host loads the plugin's Config schema, every field arrives as a live value (an
 * object exposing `get()`), so a plain `=== true` comparison reads as "unset" even though the
 * user configured it — the status report then contradicts the running behaviour.
 *
 * @param {object} cfg Live plugin config.
 * @returns {{enabled: boolean, replaceWebSearch: boolean, autoSelect: boolean, defaultLimit: number, timeoutMs: number}}
 */
function readReportConfig(cfg) {
  const search = cfg?.webSearch ?? {};
  return {
    enabled: readLive(cfg?.enabled, true) !== false,
    replaceWebSearch: readLive(search.enabled, false) === true,
    autoSelect: readLive(search.autoSelect, true) !== false,
    defaultLimit: Number(readLive(cfg?.defaultLimit, 12)) || 12,
    timeoutMs: Number(readLive(cfg?.timeoutMs, 20000)) || 20000,
  };
}

/** One source as a compact, model-readable block. */
function formatSource(source, index) {
  const lines = [`${index}. ${source.title ?? '(no title)'}`, `   ${source.url}`];
  if (source.snippet !== undefined) {
    const snippet = source.snippet.replace(/\s+/g, ' ').trim();
    lines.push(`   ${snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet}`);
  }
  if (source.publishedAt !== undefined) lines.push(`   published: ${source.publishedAt}`);
  return lines.join('\n');
}

/**
 * Render one search outcome as text.
 *
 * @param {object} outcome Result of `client.search`.
 * @param {object} request The tool arguments, for the header.
 * @returns {string} Model-readable report.
 */
export function formatSearchOutcome(outcome, request) {
  const { meta, sources, content } = outcome;
  const header =
    `RustXNG: ${JSON.stringify(request.query)}` +
    (request.engine ? ` [engine: ${request.engine}]` : '') +
    (request.category ? ` [category: ${request.category}]` : '') +
    (request.time_range ? ` [time: ${request.time_range}]` : '') +
    ` — ${sources.length} results from ${meta.engines.length} engines in ${outcome.elapsedMs} ms`;

  const blocks = [header];
  if (content !== undefined) blocks.push('', `Answer: ${content}`);
  if (sources.length === 0) {
    blocks.push('', 'No results.');
  } else {
    blocks.push('', ...sources.map((source, index) => formatSource(source, index + 1)));
  }
  if (meta.unresponsiveEngines.length > 0) {
    blocks.push('', `Unresponsive engines: ${meta.unresponsiveEngines.slice(0, 12).join('; ')}`);
  }
  if (meta.suggestions.length > 0) {
    blocks.push(`Suggestions: ${meta.suggestions.join(', ')}`);
  }
  return blocks.join('\n');
}

/**
 * Build the tools.
 *
 * @param {object} options
 * @param {Function} options.defineTool The host's `defineTool`.
 * @param {object} options.client Client from `lib/rustxng-client.js`.
 * @param {() => object} options.getConfig Live plugin config.
 * @param {() => string[]} options.statusLines Extra diagnostic lines (provider state, selection state).
 * @returns {Array<object>} Tool definitions.
 */
export function buildRustxngTools({ defineTool, client, getConfig, statusLines, ensureSelected, ensureStarted } = {}) {
  const config = () => (typeof getConfig === 'function' ? getConfig() : getConfig) ?? {};

  const searchTool = defineTool({
    name: 'rustxng_search',
    description:
      'Search the web through the locally running RustXNG metasearch instance (a self-hosted SearXNG rewrite). ' +
      'One call fans out to ~170 search engines, deduplicates the results and returns the top sources with title, URL and snippet. ' +
      'Use it when you need broad web coverage without an API key, when the user wants privacy-preserving search, ' +
      'or when the built-in web_search is answered by a different backend. ' +
      'Pass engine to search a single site (SearXNG short name, e.g. "wikipedia", "github", "arxiv"). ' +
      'Pass category to narrow the engine set (general / it / news / images / videos / science / files / music / map). ' +
      'With autoStart on, the instance is started (and the binary downloaded on first use) when the tool runs and nothing answers.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search terms. Keywords work better than a full sentence.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (1-50). Defaults to the plugin setting (12).',
      },
      engine: {
        type: 'string',
        description:
          'Restrict to one engine or a comma-separated list of engine short names, e.g. "wikipedia" or "github,gitlab". ' +
          'Omit to search every enabled engine in the category.',
      },
      category: {
        type: 'string',
        description: 'Category filter, e.g. "general", "it", "news", "science", "images", "videos". Omit for the general set.',
      },
      language: {
        type: 'string',
        description: 'Language code for the search (e.g. "ja", "en"). Defaults to the plugin setting.',
      },
      time_range: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'Keep only results published within this window.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      // A tool call runs on the agent's context, where a settings write is allowed (the
      // loader's mount transaction is not open any more) — so the hand-over is retried here.
      await ensureSelected?.();
      // Tool calls run on the agent's context, so this is also where auto-start belongs:
      // without it, a tool-only setup never starts the instance and always gets ECONNREFUSED.
      // A failed start is not fatal here — the search below reports the connection problem.
      try {
        await ensureStarted?.();
      } catch {
        /* reported by the search itself */
      }
      const cfg = config();
      const outcome = await client.search(
        {
          query: args?.query,
          limit: Number.isFinite(args?.limit) ? Number(args.limit) : undefined,
          engine: typeof args?.engine === 'string' ? args.engine : '',
          categories: typeof args?.category === 'string' && args.category.trim() !== '' ? [args.category.trim()] : undefined,
          language: typeof args?.language === 'string' ? args.language : undefined,
          timeRange: typeof args?.time_range === 'string' ? args.time_range : undefined,
        },
        exec?.signal,
      );
      if (outcome.sources.length === 0 && outcome.content === undefined) {
        return (
          `RustXNG returned no results for ${JSON.stringify(args?.query ?? '')}.\n` +
          (outcome.meta.unresponsiveEngines.length > 0
            ? `Unresponsive engines: ${outcome.meta.unresponsiveEngines.join('; ')}\n`
            : '') +
          `Instance: ${cfg.baseUrl ?? '(unset)'}`
        );
      }
      return formatSearchOutcome(outcome, {
        query: args?.query,
        engine: args?.engine,
        category: args?.category,
        time_range: args?.time_range,
      });
    },
  });

  const statusTool = defineTool({
    name: 'rustxng_status',
    description:
      'Report the state of the local RustXNG instance and of the dsh-rustxng plugin: whether the instance answers, ' +
      'its version, how many engines it has enabled, whether the plugin registers its search provider and whether ' +
      'web.searchProvider currently points at it. Use it when a RustXNG search fails or before telling the user that ' +
      'RustXNG is unavailable.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      await ensureSelected?.();
      // Status stays read-only: it reports what is running and says that the next search will
      // start the instance, instead of starting a server because someone asked for a report.
      const cfg = config();
      const lines = [];
      const probe = await client.probe();
      const baseUrl = probe.baseUrl || '(unset)';

      lines.push(`RustXNG instance: ${baseUrl}`);
      lines.push(`Reachable: ${probe.ok ? 'yes' : 'no'}`);
      if (probe.ok) {
        lines.push(`Version: ${probe.version ?? '(unknown)'}`);
        try {
          const response = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout?.(8000) });
          if (response.ok) {
            const body = await response.json();
            const engines = Array.isArray(body?.engines) ? body.engines : [];
            const enabled = engines.filter((engine) => engine?.enabled !== false).length;
            lines.push(`Engines: ${enabled} enabled / ${engines.length} configured`);
            if (typeof body?.version === 'string' && probe.version === undefined) lines.push(`Version: ${body.version}`);
          }
        } catch {
          lines.push('Engines: (could not read /config)');
        }
      } else if (probe.error !== undefined) {
        lines.push(`Error: ${probe.error}`);
        lines.push('');
        lines.push('Start RustXNG (for example `rustxng --port 8888`) or set the plugin setting `baseUrl`.');
        lines.push('`npx dsh-rustxng-fetch` downloads a release binary for Windows, macOS and Linux.');
      }

      lines.push('');
      const report = readReportConfig(cfg);
      lines.push(`Plugin setting enabled: ${report.enabled ? 'yes' : 'no'}`);
      lines.push(`Replace web_search: ${report.replaceWebSearch ? 'yes' : 'no (default)'}`);
      lines.push(`Auto-select provider: ${report.autoSelect ? 'yes' : 'no'}`);
      lines.push(`Default limit: ${report.defaultLimit} results, timeout ${report.timeoutMs} ms`);
      if (typeof statusLines === 'function') {
        for (const line of statusLines()) lines.push(line);
      }
      // Surfaced so a linked checkout can be diagnosed without reading host logs. It must not
      // claim anything about the card's own state: an earlier version printed the
      // `replaceWebSearch` value here, which read as "the card is off" while it was on.
      if (probe.ok !== true && baseUrl !== '(unset)') {
        lines.push('');
        lines.push('Settings: open Plugins → RustXNG to change these values.');
      }
      return lines.join('\n');
    },
  });

  return [searchTool, statusTool];
}
