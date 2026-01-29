export function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export function decodeBody(body) {
    if (typeof body === 'string') return body;
    return new TextDecoder().decode(body);
}

const TEXT_EXTENSIONS = new Set([
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'json', 'md', 'txt', 'css', 'html', 'htm',
    'yml', 'yaml', 'toml', 'xml', 'csv',
    'sh', 'bash', 'zsh', 'py', 'rb', 'go',
    'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp'
]);

export function isLikelyTextPath(path) {
    const lower = path.toLowerCase();
    const dotIndex = lower.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === lower.length - 1) return true;
    const ext = lower.slice(dotIndex + 1);
    return TEXT_EXTENSIONS.has(ext);
}

export async function readTextFileSafe(handle) {
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const scanLen = Math.min(bytes.length, 1024);
    for (let i = 0; i < scanLen; i++) {
        if (bytes[i] === 0) return null;
    }
    const text = new TextDecoder().decode(buffer);
    return { text, size: file.size };
}

export function buildSnippet(text, query, maxLen = 120) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) return text.slice(0, maxLen).replace(/\s+/g, ' ');
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 40);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ');
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inList = false;
    let listItemOpen = false;
    let inCode = false;
    let codeLang = '';
    let codeLines = [];
    let codeAsListItem = false;

    const closeList = () => {
        if (inList) {
            if (listItemOpen) {
                html += '</li>';
                listItemOpen = false;
            }
            html += '</ul>';
            inList = false;
        }
    };

    const makeCodeBlock = (lang, code) => {
        const safeLang = lang ? escapeHtml(lang) : '';
        const safeCode = escapeHtml(code);
        return (
            `<div class="nano-codeblock">` +
            `<button type="button" class="nano-copy">Copy</button>` +
            `<pre><code class="language-${safeLang}">${safeCode}</code></pre>` +
            `</div>`
        );
    };

    const formatInline = (text) => {
        let out = escapeHtml(text);
        const codeParts = [];
        out = out.replace(/`([^`]+)`/g, (match, code) => {
            const token = `@@INLINE_CODE_${codeParts.length}@@`;
            codeParts.push(`<code>${code}</code>`);
            return token;
        });
        out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        const segments = out.split(/(<[^>]+>)/g);
        out = segments.map((seg) => {
            if (seg.startsWith('<')) return seg;
            return seg.replace(/https?:\/\/[^\s<]+/g, (url) => {
                let clean = url;
                let tail = '';
                while (/[),.;!?]$/.test(clean)) {
                    tail = clean.slice(-1) + tail;
                    clean = clean.slice(0, -1);
                }
                return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${tail}`;
            });
        }).join('');
        out = out.replace(/@@INLINE_CODE_(\d+)@@/g, (match, index) => codeParts[Number(index)] || '');
        return out;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (inCode) {
            if (/^\s*```/.test(trimmed)) {
                const codeHtml = makeCodeBlock(codeLang, codeLines.join('\n'));
                if (codeAsListItem) {
                    if (!inList) {
                        html += '<ul>';
                        inList = true;
                    }
                    if (!listItemOpen) {
                        html += '<li>';
                        listItemOpen = true;
                    }
                    html += codeHtml;
                } else {
                    closeList();
                    html += codeHtml;
                }
                inCode = false;
                codeLang = '';
                codeLines = [];
                codeAsListItem = false;
                continue;
            }
            const contentLine = codeAsListItem ? line.replace(/^\s{2}/, '') : line;
            codeLines.push(contentLine);
            continue;
        }

        if (trimmed === '') {
            closeList();
            html += '<br>';
            continue;
        }

        const codeStartMatch = line.match(/^(\s*[-*+]\s+)?```(\w+)?\s*$/);
        if (codeStartMatch) {
            const hasListMarker = Boolean(codeStartMatch[1]);
            const isIndentedContinuation = !hasListMarker && inList && /^\s{2,}```/.test(line);
            codeAsListItem = hasListMarker || isIndentedContinuation;
            codeLang = codeStartMatch[2] || '';
            inCode = true;
            codeLines = [];
            continue;
        }

        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            html += `<h${level}>${formatInline(headingMatch[2])}</h${level}>`;
            continue;
        }

        const listMatch = line.match(/^\s*[-*+]\s+(.*)$/);
        if (listMatch) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            if (listItemOpen) {
                html += '</li>';
            }
            html += `<li>${formatInline(listMatch[1])}`;
            listItemOpen = true;
            continue;
        }

        const quoteMatch = line.match(/^\s*>\s+(.*)$/);
        if (quoteMatch) {
            closeList();
            html += `<blockquote>${formatInline(quoteMatch[1])}</blockquote>`;
            continue;
        }

        closeList();
        html += `<p>${formatInline(line)}</p>`;
    }

    if (inCode) {
        const codeHtml = makeCodeBlock(codeLang, codeLines.join('\n'));
        if (codeAsListItem) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            if (!listItemOpen) {
                html += '<li>';
                listItemOpen = true;
            }
            html += codeHtml;
        } else {
            closeList();
            html += codeHtml;
        }
    }

    closeList();
    return html;
}
