import type { BlockNode, Document, InlineNode } from './types.ts';

/** 渲染层：把物化后的 AST 投影成 HTML（视图之一，§3.2 创新 2） */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

function renderInline(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return escapeHtml(node.raw);
        case 'strong':
          return `<strong>${escapeHtml(node.raw.slice(2, -2))}</strong>`;
        case 'emphasis':
          return `<em>${escapeHtml(node.raw.slice(1, -1))}</em>`;
        case 'codeSpan':
          return `<code>${escapeHtml(node.raw.slice(1, -1))}</code>`;
        case 'link': {
          const label = node.raw.slice(1, node.raw.indexOf(']('));
          return `<a href="${escapeHtml(node.url ?? '')}">${escapeHtml(label)}</a>`;
        }
        case 'image': {
          const alt = node.raw.slice(2, node.raw.indexOf(']('));
          return `<img src="${escapeHtml(node.url ?? '')}" alt="${escapeHtml(alt)}">`;
        }
        default:
          return escapeHtml(node.raw);
      }
    })
    .join('');
}

function renderCells(line: string): string {
  const body = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  return body
    .split('|')
    .map((cell) => `<td>${escapeHtml(cell.trim())}</td>`)
    .join('');
}

export function renderBlock(block: BlockNode): string {
  const inner = renderInline(block.children).replace(/\n+$/, '');
  switch (block.role) {
    case 'heading':
      return `<h${block.depth ?? 1}>${inner}</h${block.depth ?? 1}>`;
    case 'listItem':
      return block.ordered ? `<li data-ordered="true">${inner}</li>` : `<li>${inner}</li>`;
    case 'quote':
      return `<blockquote>${inner}</blockquote>`;
    case 'code': {
      const lang = block.lang !== undefined && block.lang.length > 0 ? ` class="language-${escapeHtml(block.lang)}"` : '';
      return `<pre><code${lang}>${escapeHtml(block.content)}</code></pre>`;
    }
    case 'table': {
      const rows = block.content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => (line.includes('---') ? '' : `<tr>${renderCells(line)}</tr>`))
        .join('');
      return `<table>${rows}</table>`;
    }
    default:
      return `<p>${inner}</p>`;
  }
}

export function renderHtml(doc: Document): string {
  const out: string[] = [];
  let inList = false;
  for (const block of doc.blocks) {
    if (block.role === 'listItem') {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(renderBlock(block));
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(renderBlock(block));
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

export function renderText(doc: Document): string {
  return doc.blocks.map((block) => block.raw).join('');
}
