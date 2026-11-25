import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { db, uid, type ChatRecord } from '../../db/db';
import { openSettings } from '../../lib/nav';
import { getDocumentText } from '../../pdf/loader';
import type { ChatMessage } from '../../providers/types';
import { describeError, fillTemplate, getChatLLM, langLabel } from '../../services/translate';
import { useReader } from '../../store/reader';
import { useSettings } from '../../store/settings';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';

const QUICK = [
  { label: '总结全文', prompt: '请总结这篇论文：研究问题、方法、主要结果和结论。' },
  { label: '方法详解', prompt: '详细解释这篇论文的方法 / 模型 / 实验设计。' },
  { label: '创新与局限', prompt: '这篇论文的主要创新点和贡献是什么？有哪些局限或可改进之处？' },
  { label: '关键术语', prompt: '列出这篇论文的关键术语，并给出中英文对照与简短解释（表格）。' },
  { label: '相关工作', prompt: '梳理论文中提到的相关工作，并说明本文与它们的区别。' },
];

/** Leave room for the answer; ~4 chars per token is a rough upper bound for English. */
const CONTEXT_CHARS = 120_000;

export function ChatPanel() {
  const docId = useReader((s) => s.docId);
  const pdf = useReader((s) => s.pdf);
  const title = useReader((s) => s.title);
  const handoff = useReader((s) => (s.handoff?.target === 'chat' ? s.handoff : null));
  const consumeHandoff = useReader((s) => s.consumeHandoff);
  const chats = useLiveQuery(
    () => (docId ? db.chats.where('docId').equals(docId).reverse().sortBy('updatedAt') : []),
    [docId],
  );
  const [chatId, setChatId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ctrlRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const docTextRef = useRef<{ docId: string; text: string } | null>(null);

  const chat: ChatRecord | undefined = chats?.find((c) => c.id === chatId) ?? (chatId === null ? chats?.[0] : undefined);
  const messages = chat?.messages ?? [];

  useEffect(() => {
    if (!handoff) return;
    setInput((v) => `> ${handoff.text.replace(/\n/g, '\n> ')}\n\n${v}`);
    consumeHandoff();
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [handoff, consumeHandoff]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, streaming]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  const send = async (text: string) => {
    // Synchronous lock: the controller is claimed before the first await.
    if (!docId || !pdf || !text.trim() || ctrlRef.current) return;
    setError('');
    let llm;
    try {
      llm = getChatLLM();
    } catch (e) {
      setError(describeError(e));
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const s = useSettings.getState();
    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const history = [...messages, userMsg];
    const id = chat?.id ?? uid();
    let out = '';
    setStreaming('');
    setInput('');
    try {
      await db.chats.put({
        id,
        docId,
        title: chat?.title ?? text.trim().slice(0, 40),
        messages: history,
        updatedAt: Date.now(),
      });
      setChatId(id);
      if (docTextRef.current?.docId !== docId) {
        docTextRef.current = { docId, text: await getDocumentText(pdf, docId, CONTEXT_CHARS) };
      }
      ctrl.signal.throwIfAborted();
      const system =
        fillTemplate(s.prompts.chatSystem, { to: langLabel(s.targetLang), title }) +
        `\n\n<paper>\n${docTextRef.current.text}\n</paper>`;
      for await (const d of llm.provider.chat({
        messages: [{ role: 'system', content: system }, ...history.slice(-20)],
        signal: ctrl.signal,
        temperature: llm.cfg.temperature ?? 0.4,
      })) {
        out += d;
        setStreaming(out);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(describeError(e));
    } finally {
      // update (not put): if the chat was deleted meanwhile it stays deleted
      if (out) await db.chats.update(id, { messages: [...history, { role: 'assistant', content: out }], updatedAt: Date.now() });
      setStreaming(null);
      ctrlRef.current = null;
    }
  };

  return (
    <>
      <div className="panel-head">
        <select
          className="select"
          style={{ width: 'auto', maxWidth: 220, minHeight: 28, padding: '2px 6px' }}
          value={chat?.id ?? ''}
          onChange={(e) => setChatId(e.target.value || '')}
          disabled={streaming !== null}
          aria-label="对话"
        >
          {!chat && <option value="">新对话</option>}
          {chats?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setChatId('')} disabled={streaming !== null}>
          <Icon name="plus" size={14} /> 新对话
        </button>
        {chat && (
          <button
            className="icon-btn"
            disabled={streaming !== null}
            title="删除此对话"
            onClick={() => {
              if (confirm('删除此对话？')) {
                void db.chats.delete(chat.id);
                setChatId(null);
              }
            }}
          >
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && streaming === null && (
          <div className="empty" style={{ paddingTop: 16 }}>
            <p>基于整篇论文内容提问。</p>
            <div className="quick-actions" style={{ justifyContent: 'center' }}>
              {QUICK.map((q) => (
                <button key={q.label} className="chip" onClick={() => void send(q.prompt)}>
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
          </div>
        ))}
        {streaming !== null && (
          <div className="msg assistant">
            <div className="bubble">
              {streaming ? <Markdown text={streaming} /> : <span className="hint"><span className="spinner" /> 正在阅读论文…</span>}
            </div>
          </div>
        )}
        {error && (
          <div className="error-box">
            {error}
            {/尚未配置/.test(error) && (
              <div style={{ marginTop: 8 }}>
                <button className="btn sm primary" onClick={() => openSettings('providers')}>
                  去设置
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="chat-input">
        {messages.length > 0 && (
          <div className="quick-actions">
            {QUICK.slice(0, 4).map((q) => (
              <button key={q.label} className="chip" disabled={streaming !== null} onClick={() => void send(q.prompt)}>
                {q.label}
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            className="textarea"
            placeholder="就这篇论文提问…（Enter 发送，Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {streaming !== null ? (
            <button className="icon-btn" title="停止" onClick={() => ctrlRef.current?.abort()}>
              <Icon name="stop" />
            </button>
          ) : (
            <button className="icon-btn" title="发送" onClick={() => void send(input)} disabled={!input.trim()}>
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
