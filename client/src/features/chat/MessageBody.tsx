import { useMemo } from 'preact/hooks';
import { tokenizeMessage } from '@/lib/text';
import { openExternal } from '@/services/native/desktop';

/** Renders message text with safe links, @mentions and line breaks. Never injects HTML. */
export const MessageBody = ({ text }: { text: string }) => {
  const tokens = useMemo(() => tokenizeMessage(text), [text]);
  return (
    <p className="break-words whitespace-pre-wrap text-text">
      {tokens.map((token, index) => {
        switch (token.type) {
          case 'break':
            return <br key={index} />;
          case 'link':
            return (
              <a
                key={index}
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  openExternal(token.href);
                }}
              >
                {token.value}
              </a>
            );
          case 'mention':
            return (
              <span key={index} className="message-mention">
                {token.value}
              </span>
            );
          default:
            return <span key={index}>{token.value}</span>;
        }
      })}
    </p>
  );
};
