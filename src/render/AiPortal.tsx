import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Send, Sparkles, Trash2, User } from 'lucide-react';
import { useAppState, useDispatch, useElementsWithAncestors } from '@/app/context';
import { boardDoc } from '@/store';
import { isEffectivelyVisible } from '@/document';
import { worldMatrix } from '@/geometry';
import type { AiPortalMessage } from '@/commands/builtin/aiPortal';
import { useI18n } from '@/ui/i18n';
import styles from './AiPortal.module.css';

interface AiPortalMeta {
  messages?: AiPortalMessage[];
}

export const AiPortal = memo(function AiPortal({ id }: { id: string }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const element = useAppState((s) => boardDoc(s).elements[id]);
  const viewport = useAppState((s) => s.ui.viewport);
  // Just this portal's own ancestor chain (for worldMatrix/visibility), not the whole elements
  // table — which would re-render every portal on every edit anywhere in the document.
  const elements = useElementsWithAncestors([id]);
  const selected = useAppState((s) => s.ui.selection.includes(id));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');

  const meta = (element?.meta?.['aiPortal'] as AiPortalMeta | undefined) ?? {};
  const messages = meta.messages ?? [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = useCallback(() => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    dispatch('send-ai-portal-message', { id, text: trimmed });
    setInputText('');
  }, [dispatch, id, inputText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('clear-ai-portal-messages', { id });
    },
    [dispatch, id],
  );

  const handleHeaderClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatch('select', { ids: [id], mode: 'replace' });
    },
    [dispatch, id],
  );

  if (!element || element.kind !== 'rect' || !element.visible) return null;
  if (!isEffectivelyVisible(elements, id)) return null;

  const matrix = worldMatrix(elements, element);
  const left = matrix[4] * viewport.zoom + viewport.x;
  const top = matrix[5] * viewport.zoom + viewport.y;
  const width = element.width * viewport.zoom;
  const height = element.height * viewport.zoom;
  const rotation = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;

  const baseWidth = 400;
  const baseHeight = 300;
  const scale = Math.max(0.25, Math.min(width / baseWidth, height / baseHeight, 2.5));
  const iconScale = Math.max(0.55, Math.min(scale, 1.8));
  const titleIconSize = Math.round(18 * iconScale);
  const trashIconSize = Math.round(16 * iconScale);
  const clipIconSize = Math.round(18 * iconScale);
  const sendIconSize = Math.round(15 * iconScale);
  const bubbleIconSize = Math.round(12 * iconScale);
  const tiny = width < 80 || height < 60;

  const formatTime = (timestamp: number) => {
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div
      className={styles.portal}
      style={{
        left,
        top,
        width,
        height,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
        transformOrigin: '0 0',
        ['--portal-scale' as string]: scale,
      } as React.CSSProperties}
      data-selected={selected || undefined}
      data-tiny={tiny || undefined}
      data-testid={`ai-portal-${id}`}
    >
      <div
        className={styles.portalBar}
        onPointerDown={handleHeaderClick}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className={styles.portalTitleGroup}>
          <Sparkles size={titleIconSize} className={styles.portalSparkle} />
          <span>{t(element.name || 'AI Portal')}</span>
        </div>
        <div className={styles.portalButtons}>
          {messages.length > 0 && (
            <button
              type="button"
              className={styles.portalAction}
              aria-label={t('Clear conversation')}
              title={t('Clear conversation')}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleClear}
            >
              <Trash2 size={trashIconSize} />
            </button>
          )}
        </div>
      </div>

      <div
        className={styles.portalContent}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className={styles.messagesList}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`${styles.messageRow} ${
                msg.sender === 'user' ? styles.messageRowUser : styles.messageRowAi
              }`}
            >
              <div
                className={`${styles.messageBubble} ${
                  msg.sender === 'user' ? styles.messageBubbleUser : styles.messageBubbleAi
                }`}
              >
                {msg.sender === 'user' ? (
                  <div className={styles.senderUser}>
                    <User size={bubbleIconSize} />
                    <span>{t('You')}</span>
                  </div>
                ) : (
                  <div className={styles.senderAi}>
                    <Sparkles size={bubbleIconSize} className={styles.portalSparkle} />
                    <span>{t('AI Assistant')}</span>
                  </div>
                )}
                <div
                  className={
                    msg.sender === 'user' ? styles.messageTextUser : styles.messageTextAi
                  }
                >
                  {msg.text}
                </div>
                <div className={msg.sender === 'user' ? styles.timeUser : styles.timeAi}>
                  {formatTime(msg.timestamp)}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div
          className={styles.inputFloatingBar}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={styles.clipButton}
            title={t('Attach file')}
            aria-label={t('Attach file')}
            onClick={(e) => e.stopPropagation()}
          >
            <Paperclip size={clipIconSize} />
          </button>
          <input
            type="text"
            className={styles.chatInput}
            placeholder={t('Ask AI Assistant...')}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className={styles.sendButton}
            aria-label={t('Send message')}
            title={t('Send message')}
            disabled={!inputText.trim()}
            onClick={handleSend}
          >
            <Send size={sendIconSize} style={{ marginLeft: Math.max(1, Math.round(2 * iconScale)) }} />
          </button>
        </div>
      </div>
    </div>
  );
});
