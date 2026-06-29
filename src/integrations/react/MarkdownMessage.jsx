import React from 'react';

const safeLinkPattern = /^(https?:\/\/|mailto:|\/|#)/i;

const normalizeContent = (content) => String(content || '').replace(/\r\n/g, '\n').trim();

const isBlank = (line) => !line.trim();
const isFence = (line) => line.trim().startsWith('```');
const isHeading = (line) => /^(#{1,4})\s+/.test(line);
const isUnorderedListItem = (line) => /^\s*[-*]\s+/.test(line);
const isOrderedListItem = (line) => /^\s*\d+[.)]\s+/.test(line);
const isBlockquote = (line) => /^\s*>\s?/.test(line);
const isTableSeparator = (line) => {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
};
const isTableStart = (lines, index) => {
  return lines[index]?.includes('|') && isTableSeparator(lines[index + 1] || '');
};

const splitTableRow = (line) => {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
};

const startsBlock = (lines, index) => {
  const line = lines[index] || '';
  return (
    isFence(line)
    || isHeading(line)
    || isUnorderedListItem(line)
    || isOrderedListItem(line)
    || isBlockquote(line)
    || isTableStart(lines, index)
  );
};

const parseBlocks = (content) => {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return [];
  }

  const lines = normalized.split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index += 1;
      continue;
    }

    if (isFence(lines[index])) {
      const language = lines[index].trim().slice(3).trim();
      const codeLines = [];
      index += 1;

      while (index < lines.length && !isFence(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({ type: 'code', language, text: codeLines.join('\n') });
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const rows = [];
      index += 2;

      while (index < lines.length && lines[index].includes('|') && !isBlank(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }

      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(lines[index]);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isUnorderedListItem(lines[index]) || isOrderedListItem(lines[index])) {
      const ordered = isOrderedListItem(lines[index]);
      const items = [];
      const matcher = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;

      while (
        index < lines.length
        && (ordered ? isOrderedListItem(lines[index]) : isUnorderedListItem(lines[index]))
      ) {
        items.push(lines[index].replace(matcher, '').trim());
        index += 1;
      }

      blocks.push({ type: ordered ? 'orderedList' : 'unorderedList', items });
      continue;
    }

    if (isBlockquote(lines[index])) {
      const quoteLines = [];

      while (index < lines.length && isBlockquote(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, '').trim());
        index += 1;
      }

      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    if (paragraphLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
    } else {
      blocks.push({ type: 'paragraph', text: lines[index].trim() });
      index += 1;
    }
  }

  return blocks;
};

const renderInline = (text) => {
  const value = String(text || '');
  const tokens = [];
  const pattern = /(\*\*[^*]+?\*\*|`[^`]+?`|\[[^\]\n]+?\]\([^)]+?\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      tokens.push(value.slice(lastIndex, match.index));
    }

    const token = match[0];

    if (token.startsWith('**')) {
      tokens.push({
        type: 'strong',
        text: token.slice(2, -2),
      });
    } else if (token.startsWith('`')) {
      tokens.push({
        type: 'code',
        text: token.slice(1, -1),
      });
    } else {
      const linkMatch = /^\[([^\]\n]+?)\]\(([^)]+?)\)$/.exec(token);
      if (linkMatch && safeLinkPattern.test(linkMatch[2])) {
        tokens.push({
          type: 'link',
          text: linkMatch[1],
          href: linkMatch[2],
        });
      } else {
        tokens.push(token);
      }
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) {
    tokens.push(value.slice(lastIndex));
  }

  return tokens.map((token, index) => {
    if (typeof token === 'string') {
      return <React.Fragment key={index}>{token}</React.Fragment>;
    }

    if (token.type === 'strong') {
      return <strong key={index} className="psa-md-strong">{token.text}</strong>;
    }

    if (token.type === 'code') {
      return <code key={index} className="psa-md-inline-code">{token.text}</code>;
    }

    return (
      <a
        key={index}
        href={token.href}
        target={token.href.startsWith('#') || token.href.startsWith('/') ? undefined : '_blank'}
        rel={token.href.startsWith('#') || token.href.startsWith('/') ? undefined : 'noreferrer'}
        className="psa-md-link"
      >
        {token.text}
      </a>
    );
  });
};

export default function MarkdownMessage({ content }) {
  const blocks = parseBlocks(content);

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="psa-markdown">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const HeadingTag = block.level <= 1 ? 'h3' : 'h4';
          return (
            <HeadingTag key={index} className="psa-md-heading">
              {renderInline(block.text)}
            </HeadingTag>
          );
        }

        if (block.type === 'unorderedList' || block.type === 'orderedList') {
          const ListTag = block.type === 'orderedList' ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="psa-md-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ListTag>
          );
        }

        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="psa-md-quote">
              {block.text.split('\n').map((line, lineIndex) => (
                <React.Fragment key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  {renderInline(line)}
                </React.Fragment>
              ))}
            </blockquote>
          );
        }

        if (block.type === 'code') {
          return (
            <pre key={index} className="psa-md-code-block">
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={index} className="psa-md-table-wrap">
              <table className="psa-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex}>{renderInline(row[cellIndex] || '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={index} className="psa-md-paragraph">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
