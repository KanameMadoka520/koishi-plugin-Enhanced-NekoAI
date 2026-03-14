const logger = require('./logger');
const state = require('./state');

const MAX_PERSONALITY_RENDER_COUNT = 20;
const MODEL_LIST_RENDER_PAGE_SIZE = 30;
const MODEL_LIST_RENDER_COLUMNS = 5;
const RENDER_ROOT_SELECTOR = '#neko-render-root';
const CARD_CONTENT_WIDTH = 1040;
const RENDER_ROOT_PADDING_X = 28;
const RENDER_ROOT_PADDING_TOP = 24;
const RENDER_ROOT_PADDING_BOTTOM = 48;
const RENDER_ROOT_WIDTH = CARD_CONTENT_WIDTH + RENDER_ROOT_PADDING_X * 2;
const MAX_RENDER_HEIGHT = 4096;
const DEFAULT_VIEWPORT = {
  width: RENDER_ROOT_WIDTH,
  height: 720,
  deviceScaleFactor: 2,
};

const UI_THEMES = {
  1: {
    name: '极光玻璃',
    rootBg: 'linear-gradient(135deg, #eef4ff 0%, #f7f4ff 52%, #eefaf6 100%)',
    rootOverlay: 'radial-gradient(circle at top right, rgba(99, 102, 241, 0.18), transparent 42%), radial-gradient(circle at left bottom, rgba(16, 185, 129, 0.12), transparent 38%)',
    cardBg: 'rgba(255, 255, 255, 0.88)',
    cardBorder: 'rgba(99, 102, 241, 0.18)',
    cardShadow: '0 24px 64px rgba(79, 70, 229, 0.16)',
    headerBg: 'linear-gradient(135deg, rgba(99, 102, 241, 0.16), rgba(56, 189, 248, 0.10))',
    titleColor: '#243b6b',
    subtitleColor: '#5f6c8c',
    eyebrowBg: 'rgba(79, 70, 229, 0.10)',
    eyebrowColor: '#3a47a8',
    sectionBg: 'rgba(255, 255, 255, 0.82)',
    sectionBorder: 'rgba(148, 163, 184, 0.24)',
    sectionTitleBg: 'rgba(79, 70, 229, 0.10)',
    sectionTitleColor: '#3948aa',
    itemBg: '#f8fbff',
    itemBorder: 'rgba(203, 213, 225, 0.84)',
    itemTitle: '#172033',
    itemDesc: '#627089',
    activeBg: 'linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(56, 189, 248, 0.08))',
    activeBorder: 'rgba(99, 102, 241, 0.38)',
    badgeBg: '#5865f2',
    badgeText: '#ffffff',
    tagBg: 'rgba(79, 70, 229, 0.12)',
    tagColor: '#3948aa',
  },
  2: {
    name: '深色终端',
    rootBg: 'linear-gradient(135deg, #07111f 0%, #0d1728 48%, #111827 100%)',
    rootOverlay: 'radial-gradient(circle at top right, rgba(34, 197, 94, 0.18), transparent 34%), radial-gradient(circle at left bottom, rgba(59, 130, 246, 0.22), transparent 36%)',
    cardBg: 'rgba(9, 16, 30, 0.94)',
    cardBorder: 'rgba(56, 189, 248, 0.20)',
    cardShadow: '0 28px 72px rgba(2, 6, 23, 0.42)',
    headerBg: 'linear-gradient(135deg, rgba(12, 24, 46, 0.96), rgba(14, 50, 72, 0.92))',
    titleColor: '#ecfeff',
    subtitleColor: '#94a3b8',
    eyebrowBg: 'rgba(34, 197, 94, 0.14)',
    eyebrowColor: '#86efac',
    sectionBg: 'rgba(12, 22, 39, 0.88)',
    sectionBorder: 'rgba(51, 65, 85, 0.88)',
    sectionTitleBg: 'rgba(34, 197, 94, 0.12)',
    sectionTitleColor: '#86efac',
    itemBg: '#0f1b31',
    itemBorder: 'rgba(51, 65, 85, 0.94)',
    itemTitle: '#e2e8f0',
    itemDesc: '#8ea0b8',
    activeBg: 'linear-gradient(135deg, rgba(30, 64, 175, 0.34), rgba(8, 145, 178, 0.24))',
    activeBorder: 'rgba(34, 197, 94, 0.42)',
    badgeBg: '#22c55e',
    badgeText: '#052e16',
    tagBg: 'rgba(56, 189, 248, 0.14)',
    tagColor: '#7dd3fc',
  },
  3: {
    name: '暖纸卡片',
    rootBg: 'linear-gradient(135deg, #fbf2df 0%, #fff8ef 52%, #f6ead4 100%)',
    rootOverlay: 'radial-gradient(circle at top right, rgba(217, 119, 6, 0.12), transparent 36%), radial-gradient(circle at left bottom, rgba(180, 83, 9, 0.10), transparent 34%)',
    cardBg: 'rgba(255, 251, 243, 0.96)',
    cardBorder: 'rgba(180, 83, 9, 0.16)',
    cardShadow: '0 20px 56px rgba(146, 64, 14, 0.12)',
    headerBg: 'linear-gradient(135deg, rgba(245, 158, 11, 0.16), rgba(251, 191, 36, 0.10))',
    titleColor: '#6f3f18',
    subtitleColor: '#8a6848',
    eyebrowBg: 'rgba(180, 83, 9, 0.10)',
    eyebrowColor: '#92400e',
    sectionBg: 'rgba(255, 253, 247, 0.96)',
    sectionBorder: 'rgba(217, 119, 6, 0.18)',
    sectionTitleBg: 'rgba(217, 119, 6, 0.10)',
    sectionTitleColor: '#9a5b1a',
    itemBg: '#fffaf1',
    itemBorder: 'rgba(217, 119, 6, 0.16)',
    itemTitle: '#4b2d16',
    itemDesc: '#8a6848',
    activeBg: 'linear-gradient(135deg, rgba(251, 191, 36, 0.18), rgba(217, 119, 6, 0.08))',
    activeBorder: 'rgba(180, 83, 9, 0.34)',
    badgeBg: '#b45309',
    badgeText: '#fffaf0',
    tagBg: 'rgba(180, 83, 9, 0.10)',
    tagColor: '#92400e',
  },
};

function escapeHtml(source) {
  return String(source ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getCurrentTheme() {
  const mode = Number(state.runtimeConfig.uiStyle) || 1;
  return {
    mode: UI_THEMES[mode] ? mode : 1,
    theme: UI_THEMES[mode] || UI_THEMES[1],
  };
}

function renderThemeVars(theme) {
  return [
    `--root-bg:${theme.rootBg}`,
    `--root-overlay:${theme.rootOverlay}`,
    `--card-bg:${theme.cardBg}`,
    `--card-border:${theme.cardBorder}`,
    `--card-shadow:${theme.cardShadow}`,
    `--header-bg:${theme.headerBg}`,
    `--title-color:${theme.titleColor}`,
    `--subtitle-color:${theme.subtitleColor}`,
    `--eyebrow-bg:${theme.eyebrowBg}`,
    `--eyebrow-color:${theme.eyebrowColor}`,
    `--section-bg:${theme.sectionBg}`,
    `--section-border:${theme.sectionBorder}`,
    `--section-title-bg:${theme.sectionTitleBg}`,
    `--section-title-color:${theme.sectionTitleColor}`,
    `--item-bg:${theme.itemBg}`,
    `--item-border:${theme.itemBorder}`,
    `--item-title:${theme.itemTitle}`,
    `--item-desc:${theme.itemDesc}`,
    `--active-bg:${theme.activeBg}`,
    `--active-border:${theme.activeBorder}`,
    `--badge-bg:${theme.badgeBg}`,
    `--badge-text:${theme.badgeText}`,
    `--tag-bg:${theme.tagBg}`,
    `--tag-color:${theme.tagColor}`,
  ].join(';');
}

function renderPageHtml(title, subtitle, sections, options = {}) {
  const { mode, theme } = getCurrentTheme();
  const layout = options.layout || 'help';
  const sectionColumns = options.sectionColumns || (() => {
    if (layout === 'help' || layout === 'status') {
      return Math.min(2, Math.max(1, sections.length));
    }
    return 1;
  })();
  const pills = options.pills || [
    `UI ${mode}`,
    theme.name,
    layout === 'help' ? '双栏指令卡片' : '双列人格卡片',
  ];

  const sectionHtml = sections.map((section) => {
    const itemColumns = section.itemColumns || 1;
    const listClass = itemColumns > 1 ? 'item-list item-list-multi' : 'item-list';
    const listStyle = itemColumns > 1 ? ` style="--item-columns:${itemColumns};"` : '';

    const items = (section.items || []).map((item) => {
      const badge = item.highlight ? '<span class="item-badge">当前使用</span>' : '';
      const tag = item.tag ? `<span class="item-tag">${escapeHtml(item.tag)}</span>` : '';
      const desc = item.description ? `<div class="item-desc">${escapeHtml(item.description)}</div>` : '';
      return `<li class="item-row${item.highlight ? ' item-row-active' : ''}">
        <div class="item-main">
          <div class="item-head">
            ${tag}
            <div class="item-title">${escapeHtml(item.title)}</div>
          </div>
          ${desc}
        </div>
        ${badge}
      </li>`;
    }).join('');

    return `<section class="section-card">
      <div class="section-title">${escapeHtml(section.title)}</div>
      <ul class="${listClass}"${listStyle}>${items}</ul>
    </section>`;
  }).join('');

  return `
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <style>
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          padding: 0;
          background: transparent;
        }
        body {
          display: inline-block;
          color: var(--item-title);
          font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
        }
        .render-root {
          position: relative;
          width: ${RENDER_ROOT_WIDTH}px;
          padding: ${RENDER_ROOT_PADDING_TOP}px ${RENDER_ROOT_PADDING_X}px ${RENDER_ROOT_PADDING_BOTTOM}px;
          background: var(--root-bg);
          overflow: hidden;
        }
        .render-root::before {
          content: "";
          position: absolute;
          inset: 0;
          background: var(--root-overlay);
          pointer-events: none;
        }
        .render-shell {
          position: relative;
          z-index: 1;
        }
        .card {
          width: 100%;
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 28px;
          overflow: hidden;
          box-shadow: var(--card-shadow);
          backdrop-filter: blur(18px);
        }
        .header {
          padding: 24px 28px 20px;
          background: var(--header-bg);
          border-bottom: 1px solid var(--card-border);
        }
        .eyebrow-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 12px;
        }
        .eyebrow {
          display: inline-flex;
          align-items: center;
          padding: 5px 10px;
          border-radius: 999px;
          background: var(--eyebrow-bg);
          color: var(--eyebrow-color);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .title {
          font-size: 30px;
          line-height: 1.2;
          font-weight: 800;
          color: var(--title-color);
        }
        .subtitle {
          max-width: 760px;
          margin-top: 10px;
          font-size: 14px;
          line-height: 1.65;
          color: var(--subtitle-color);
        }
        .section-grid {
          padding: 20px 24px 26px;
          display: grid;
          gap: 16px;
        }
        .section-grid-help {
          grid-template-columns: repeat(${sectionColumns}, minmax(0, 1fr));
          align-items: stretch;
        }
        .section-grid-personality {
          grid-template-columns: 1fr;
        }
        .section-grid-models {
          grid-template-columns: 1fr;
        }
        .section-grid-status {
          grid-template-columns: repeat(${sectionColumns}, minmax(0, 1fr));
          align-items: stretch;
        }
        .section-card {
          min-width: 0;
          background: var(--section-bg);
          border: 1px solid var(--section-border);
          border-radius: 20px;
          padding: 16px;
        }
        .section-title {
          display: inline-flex;
          align-items: center;
          padding: 6px 11px;
          margin-bottom: 12px;
          border-radius: 999px;
          background: var(--section-title-bg);
          color: var(--section-title-color);
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.01em;
        }
        .item-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 10px;
          grid-template-columns: 1fr;
        }
        .item-list-multi {
          grid-template-columns: repeat(var(--item-columns), minmax(0, 1fr));
        }
        .item-row {
          min-width: 0;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 13px;
          background: var(--item-bg);
          border: 1px solid var(--item-border);
          border-radius: 15px;
        }
        .item-row-active {
          background: var(--active-bg);
          border-color: var(--active-border);
        }
        .item-main {
          min-width: 0;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .item-head {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .item-tag {
          display: inline-flex;
          align-items: center;
          padding: 3px 8px;
          border-radius: 999px;
          background: var(--tag-bg);
          color: var(--tag-color);
          font-size: 11px;
          font-weight: 700;
          white-space: nowrap;
        }
        .item-title {
          min-width: 0;
          font-size: 14px;
          line-height: 1.5;
          font-weight: 700;
          color: var(--item-title);
          word-break: break-word;
        }
        .item-desc {
          font-size: 12px;
          line-height: 1.6;
          color: var(--item-desc);
          word-break: break-word;
        }
        .item-badge {
          display: inline-flex;
          align-items: center;
          white-space: nowrap;
          padding: 4px 10px;
          border-radius: 999px;
          background: var(--badge-bg);
          color: var(--badge-text);
          font-size: 11px;
          font-weight: 800;
        }
        .section-grid-personality .section-card {
          padding: 18px;
        }
        .section-grid-personality .item-row {
          min-height: 82px;
        }
        .section-grid-personality .item-title {
          font-size: 15px;
        }
        .section-grid-models .section-card {
          padding: 16px;
        }
        .section-grid-models .item-list {
          gap: 8px;
        }
        .section-grid-models .item-row {
          min-height: 88px;
          padding: 10px 11px;
        }
        .section-grid-models .item-title {
          font-size: 13px;
          line-height: 1.35;
        }
        .section-grid-models .item-desc {
          font-size: 11px;
          line-height: 1.45;
        }
        .section-grid-models .item-badge {
          padding: 3px 8px;
          font-size: 10px;
        }
        .section-grid-status .item-row {
          min-height: 84px;
        }
      </style>
    </head>
    <body>
      <div id="neko-render-root" class="render-root" style="${renderThemeVars(theme)}">
        <div class="render-shell">
          <div class="card">
            <div class="header">
              <div class="eyebrow-row">
                ${pills.map((pill) => `<span class="eyebrow">${escapeHtml(pill)}</span>`).join('')}
              </div>
              <div class="title">${escapeHtml(title)}</div>
              <div class="subtitle">${escapeHtml(subtitle)}</div>
            </div>
            <div class="section-grid section-grid-${layout}">${sectionHtml}</div>
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

async function waitForLayoutStable(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function renderImage(ctx, html) {
  if (!ctx?.puppeteer?.render) {
    throw new Error('puppeteer service unavailable');
  }
  return ctx.puppeteer.render(html, async (page, next) => {
    await page.setViewport(DEFAULT_VIEWPORT);
    await waitForLayoutStable(page);

    const contentHeight = await page.evaluate(() => {
      const root = document.querySelector('#neko-render-root');
      if (!root) return 0;
      const rect = root.getBoundingClientRect();
      return Math.ceil(Math.max(
        rect.height,
        root.scrollHeight || 0,
        root.clientHeight || 0,
      ));
    });

    if (contentHeight > DEFAULT_VIEWPORT.height) {
      if (contentHeight > MAX_RENDER_HEIGHT) {
        throw new Error(`render target too tall: ${contentHeight}px`);
      }

      await page.setViewport({
        ...DEFAULT_VIEWPORT,
        height: contentHeight + 8,
      });
      await waitForLayoutStable(page);
    }

    const root = await page.$(RENDER_ROOT_SELECTOR);
    if (!root) {
      throw new Error('render target root not found');
    }
    return next(root);
  });
}

async function renderHelpMenuCard(ctx, data) {
  const html = renderPageHtml(data.title, data.subtitle, data.sections, { layout: 'help' });
  return renderImage(ctx, html);
}

async function renderPersonalityListCard(ctx, data) {
  if ((data.items || []).length > MAX_PERSONALITY_RENDER_COUNT) {
    logger.warn(`人格列表过长，跳过图片渲染: ${data.title} (${data.items.length}项)`);
    return null;
  }

  const html = renderPageHtml(data.title, data.subtitle, [
    {
      title: data.sectionTitle,
      items: data.items,
      itemColumns: (data.items || []).length > 1 ? 2 : 1,
    },
  ], { layout: 'personality' });
  return renderImage(ctx, html);
}

async function renderModelListCard(ctx, data) {
  if ((data.items || []).length === 0) {
    return null;
  }

  const html = renderPageHtml(data.title, data.subtitle, [
    {
      title: data.sectionTitle,
      items: data.items,
      itemColumns: MODEL_LIST_RENDER_COLUMNS,
    },
  ], {
    layout: 'models',
    pills: data.pills,
  });
  return renderImage(ctx, html);
}

async function renderStatusPanelCard(ctx, data) {
  const html = renderPageHtml(data.title, data.subtitle, data.sections, {
    layout: 'status',
    pills: data.pills,
    sectionColumns: 2,
  });
  return renderImage(ctx, html);
}

module.exports = {
  renderHelpMenuCard,
  renderPersonalityListCard,
  renderModelListCard,
  renderStatusPanelCard,
  MAX_PERSONALITY_RENDER_COUNT,
  MODEL_LIST_RENDER_PAGE_SIZE,
};
