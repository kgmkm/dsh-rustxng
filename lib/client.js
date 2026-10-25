/**
 * Browser half of dsh-rustxng: the settings card in the Plugins page.
 *
 * The Web GUI renders no page for a Host plugin schema by itself, so the switches have to
 * be a client contribution — the official "Web search" page is the same shape. This file
 * is the package's `./client` export (`dsh.client` in package.json) and may use only the
 * shared browser modules (`react`).
 *
 * Everything shown comes from the host-owned configuration form (`configForms`); the card
 * never keeps a second copy of the settings. `baseUrl`, `webSearch.enabled` and
 * `webSearch.autoSelect` are volatile on the Host, so writing them here applies without a
 * restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rustxng',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');

    /** Host plugin entry id, which is also the settings namespace this card writes. */
    const ENTRY_ID = 'dsh-rustxng';

    /** Client services: slot registration and the shared configuration forms. */
    const inject = ['slots', 'configForms'];

    /** Runtime strings. `meta.*` in locale/*.json covers the plugin row and bundle list. */
    const messages = {
      en: {
        title: 'RustXNG web search',
        summary: 'Answer the built-in web_search with your own RustXNG instance.',
        body:
          'RustXNG is a self-hosted metasearch engine (a Rust rewrite of SearXNG). Point the plugin at your ' +
          'instance and the built-in web_search is answered by it: about 170 engines, no API key, no tracking.',
        enable: 'Use RustXNG for web_search',
        enableHint:
          'Registers the "rustxng" provider and points web.searchProvider at it. Turning this off gives the previous selection back.',
        autoSelect: 'Select it automatically',
        autoSelectHint:
          'Off: register the provider only and choose it yourself (web.searchProvider, or DSH_WEB_SEARCH_PROVIDER=rustxng).',
        baseUrl: 'Instance URL',
        baseUrlHint: 'Where RustXNG listens. Default http://127.0.0.1:8888.',
        open: 'Open the RustXNG search UI',
        status: 'Ask the agent to run rustxng_status to see whether the instance answers.',
        note:
          'RustXNG must be running (for example `rustxng --port 8888`). ' +
          'web_fetch is not affected: only search goes through RustXNG.',
        save: 'Apply',
        loading: 'Loading…',
        unavailable: 'This profile does not accept settings edits from the browser.',
      },
      ja: {
        title: 'RustXNG ウェブ検索',
        summary: '内蔵の web_search を、自前の RustXNG で答えます。',
        body:
          'RustXNG はセルフホスト型のメタ検索エンジン（SearXNG の Rust 実装）です。接続先を指定すると、' +
          '内蔵 web_search が RustXNG 経由になります。約 170 エンジン、API キー不要、追跡なし。',
        enable: 'web_search に RustXNG を使う',
        enableHint:
          '"rustxng" プロバイダを登録し、web.searchProvider をそこへ向けます。オフにすると以前の選択に戻します。',
        autoSelect: '自動で選択する',
        autoSelectHint:
          'オフ: プロバイダの登録だけ行い、選択は手動にします（web.searchProvider か DSH_WEB_SEARCH_PROVIDER=rustxng）。',
        baseUrl: '接続先 URL',
        baseUrlHint: 'RustXNG の待ち受けアドレス。既定は http://127.0.0.1:8888。',
        open: 'RustXNG の検索画面を開く',
        status: '接続確認は、エージェントに rustxng_status を実行させると分かります。',
        note:
          'RustXNG が起動している必要があります（例: `rustxng --port 8888`）。' +
          'web_fetch は影響を受けません（RustXNG を通るのは検索だけ）。',
        save: '適用',
        loading: '読み込み中…',
        unavailable: 'このプロファイルはブラウザからの設定変更を受け付けません。',
      },
    };

    /** Pick the dictionary for the active locale (ja → ja, everything else → en). */
    function dictionary(ctx) {
      let id = '';
      try {
        const snapshot = ctx?.locale?.getLocale?.();
        id = String(snapshot?.id ?? snapshot?.locale ?? '').toLowerCase();
      } catch {
        id = '';
      }
      return id.startsWith('ja') ? messages.ja : messages.en;
    }

    const styles = {
      card: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px' },
      title: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      body: { margin: 0, fontSize: '13px', lineHeight: '20px', opacity: 0.75 },
      row: { display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px', lineHeight: '20px' },
      checkbox: { marginTop: '3px', flex: 'none' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' },
      inputRow: { display: 'flex', gap: '8px', alignItems: 'center' },
      input: {
        flex: '1 1 auto',
        minWidth: 0,
        padding: '6px 8px',
        fontSize: '13px',
        lineHeight: '18px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.35))',
        background: 'var(--dsw-alias-bg-input, transparent)',
        color: 'inherit',
        fontFamily: 'inherit',
      },
      button: {
        padding: '6px 12px',
        fontSize: '13px',
        lineHeight: '18px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.35))',
        background: 'var(--dsw-alias-bg-control, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      note: { margin: 0, fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
      indent: { paddingLeft: '24px' },
      link: { fontSize: '13px', color: 'var(--dsw-alias-text-link, #3b82f6)' },
    };

    /**
     * Subscribe to the shared configuration form.
     *
     * `subscribe` and `getSnapshot` are methods on the controller, so they are rebound once:
     * passing them unbound to `useSyncExternalStore` would lose `this`.
     */
    function useFormState(form) {
      const subscribe = react.useCallback(
        (listener) => (typeof form?.subscribe === 'function' ? form.subscribe(listener) : () => {}),
        [form],
      );
      const getSnapshot = react.useCallback(
        () => (typeof form?.getSnapshot === 'function' ? form.getSnapshot() : { status: 'unavailable' }),
        [form],
      );
      return react.useSyncExternalStore(subscribe, getSnapshot);
    }

    /** One checkbox row: the value comes from the form, the write goes back to the Host. */
    function Field({ id, label, hint, checked, disabled, onChange }) {
      return react.createElement(
        'div',
        { style: styles.row },
        react.createElement('input', {
          id,
          type: 'checkbox',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          style: styles.checkbox,
          checked,
          disabled,
          onChange: (event) => onChange(event.currentTarget.checked),
        }),
        react.createElement(
          'label',
          { htmlFor: id },
          label,
          hint === undefined ? null : react.createElement('div', { style: { opacity: 0.7 } }, hint),
        ),
      );
    }

    /** Build the card component for the active locale. */
    function createCard(ctx) {
      const t = dictionary(ctx);

      return function RustxngCard(props) {
        const form = props.form;
        // List view: the injected shared controller (subscribe/getSnapshot/mutate).
        // Detail view: the page overrides `form` with a { state, mutate } wrapper
        // (see PluginManagerPage formFor). Support both so the detail page keeps working.
        const usingWrapper =
          form !== null && typeof form === 'object' && typeof form.getSnapshot !== 'function' && form.state !== undefined;
        const live = usingWrapper ? null : useFormState(form);
        const state = usingWrapper ? form.state : live;

        // Draft for the URL field: the Host owns the value, this is only what is being typed.
        const currentBaseUrl = String(state?.value?.baseUrl ?? '');
        const [draft, setDraft] = react.useState(currentBaseUrl);
        react.useEffect(() => {
          setDraft(currentBaseUrl);
        }, [currentBaseUrl]);

        const loading = state?.status === 'loading';
        const ready = state?.status === 'ready' && state.writable !== false;
        const enabled = state?.value?.webSearch?.enabled === true;
        const autoSelect = state?.value?.webSearch?.autoSelect !== false;

        const write = (path, value) => {
          try {
            const result = form.mutate([{ op: 'set', path, value }]);
            if (result !== undefined && typeof result.catch === 'function') result.catch(() => {});
          } catch {
            /* the next snapshot still comes from the Host, so a refused write needs no local rollback */
          }
        };

        if (props.view === 'summary') return t.summary;

        const commitBaseUrl = () => {
          const value = draft.trim();
          if (value !== '' && value !== currentBaseUrl) write(['baseUrl'], value);
        };
        const openUrl = (currentBaseUrl || draft || 'http://127.0.0.1:8888').replace(/\/+$/, '');

        return react.createElement(
          'section',
          { style: styles.card },
          react.createElement('h3', { style: styles.title }, t.title),
          react.createElement('p', { style: styles.body }, t.body),
          loading
            ? react.createElement('p', { style: styles.body }, t.loading)
            : react.createElement(
                react.Fragment,
                null,
                react.createElement(Field, {
                  id: 'dsh-rustxng-enabled',
                  label: t.enable,
                  hint: t.enableHint,
                  checked: enabled,
                  disabled: !ready,
                  onChange: (value) => write(['webSearch', 'enabled'], value),
                }),
                react.createElement(
                  'div',
                  { style: styles.indent },
                  react.createElement(Field, {
                    id: 'dsh-rustxng-autoselect',
                    label: t.autoSelect,
                    hint: t.autoSelectHint,
                    checked: autoSelect,
                    disabled: !ready || !enabled,
                    onChange: (value) => write(['webSearch', 'autoSelect'], value),
                  }),
                ),
                react.createElement(
                  'div',
                  { style: styles.field },
                  react.createElement('label', { htmlFor: 'dsh-rustxng-baseurl' }, t.baseUrl),
                  react.createElement(
                    'div',
                    { style: styles.inputRow },
                    react.createElement('input', {
                      id: 'dsh-rustxng-baseurl',
                      type: 'url',
                      inputMode: 'url',
                      spellCheck: false,
                      autoComplete: 'off',
                      style: styles.input,
                      value: draft,
                      disabled: !ready,
                      placeholder: 'http://127.0.0.1:8888',
                      onChange: (event) => setDraft(event.currentTarget.value),
                      onBlur: commitBaseUrl,
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitBaseUrl();
                        }
                      },
                    }),
                    react.createElement(
                      'button',
                      {
                        type: 'button',
                        style: styles.button,
                        disabled: !ready || draft.trim() === '' || draft.trim() === currentBaseUrl,
                        onClick: commitBaseUrl,
                      },
                      t.save,
                    ),
                  ),
                  react.createElement('div', { style: styles.note }, t.baseUrlHint),
                ),
                react.createElement(
                  'a',
                  { href: openUrl, target: '_blank', rel: 'noreferrer noopener', style: styles.link },
                  t.open,
                ),
              ),
          state?.status === 'unavailable' || state?.writable === false
            ? react.createElement('p', { style: styles.note }, t.unavailable)
            : null,
          react.createElement('p', { style: styles.note }, t.note),
        );
      };
    }

    /**
     * Mount the card while the Host serves this plugin's settings namespace.
     *
     * `whileServed` keeps the card off a deployment that never loaded the plugin, and the
     * card is appended to the Plugins page's item list — the same list the official Web
     * search card uses.
     *
     * The form itself is owned by `configForms`: it stays in the provider's cache, is
     * disposed with the provider, and disposing it here would leave a dead controller
     * behind for the next mount.
     */
    function apply(ctx) {
      const form = ctx.configForms.get(ENTRY_ID);
      const Card = createCard(ctx);
      const label = () => (dictionary(ctx) === messages.ja ? 'RustXNG' : 'RustXNG');

      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'dsh-rustxng',
                  order: 70,
                  label,
                  inject: () => ({ form }),
                },
                Card,
              ),
            ),
          ),
        'dsh-rustxng: settings card',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
