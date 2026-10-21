import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { cn } from '@/lib/cn';
import { parseMarkdown, type BlockNode, type InlineNode, type MentionName } from '@/lib/markdown';
import { openExternal } from '@/services/native/desktop';

interface MessageBodyProps {
  text: string;
  /** The server's resolved mentions: matched exactly in the text, names with spaces included. */
  mentions?: readonly MentionName[];
  /** Our account id: mentions of us are lit up. */
  selfId?: string | null;
  /** Shown after the last line in small type ("edited"). */
  trailer?: ComponentChildren;
  className?: string;
}

/** Hidden until clicked (or activated with the keyboard); the text underneath is kept out of the accessibility tree meanwhile. */
const Spoiler = ({ children }: { children: ComponentChildren }) => {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <span className="spoiler is-revealed">{children}</span>;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Spoiler, click to reveal"
      className="spoiler"
      onClick={(event) => {
        event.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setRevealed(true);
      }}
    >
      <span aria-hidden="true">{children}</span>
    </span>
  );
};

const renderInline = (nodes: readonly InlineNode[], selfId: string | null | undefined): ComponentChildren =>
  nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.value;
      case 'break':
        return <br key={index} />;
      case 'code':
        return (
          <code key={index} className="inline-code">
            {node.value}
          </code>
        );
      case 'bold':
        return <strong key={index}>{renderInline(node.children, selfId)}</strong>;
      case 'italic':
        return <em key={index}>{renderInline(node.children, selfId)}</em>;
      case 'spoiler':
        return <Spoiler key={index}>{renderInline(node.children, selfId)}</Spoiler>;
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openExternal(node.href);
            }}
          >
            {node.value}
          </a>
        );
      case 'mention':
        return (
          <span key={index} className={cn('message-mention', selfId && node.accountId === selfId && 'is-me')} data-account-id={node.accountId ?? undefined}>
            {node.value}
          </span>
        );
    }
  });

const renderBlocks = (blocks: readonly BlockNode[], selfId: string | null | undefined, trailer: ComponentChildren, className?: string): ComponentChildren =>
  blocks.map((block, index) => {
    const last = index === blocks.length - 1;
    if (block.type === 'codeblock') {
      return (
        <pre key={index} className="code-block scrollbar-thin" data-language={block.language ?? undefined}>
          <code>{block.value}</code>
          {last && trailer}
        </pre>
      );
    }
    return (
      <p key={index} className={cn('break-words whitespace-pre-wrap text-text', className)}>
        {renderInline(block.children, selfId)}
        {last && trailer}
      </p>
    );
  });

/**
 * Renders message text: lightweight markdown (bold, italic, inline code, fenced code
 * blocks, spoilers), safe links and @mentions, with line breaks kept. Everything is
 * built from Preact elements and text nodes; no HTML is ever injected.
 */
export const MessageBody = ({ text, mentions, selfId, trailer, className }: MessageBodyProps) => {
  const blocks = useMemo(() => parseMarkdown(text, { mentions }), [text, mentions]);
  if (blocks.length === 0) return trailer ? <p className={cn('text-text', className)}>{trailer}</p> : null;
  return <div className="message-body min-w-0">{renderBlocks(blocks, selfId, trailer, className)}</div>;
};
