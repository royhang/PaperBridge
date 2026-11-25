import 'katex/dist/katex.min.css';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Normalise \( \) and \[ \] delimiters (common in LLM output) to $ / $$ for remark-math. */
function normaliseMath(s: string) {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `$$${m}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m}$`);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="result">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}>
        {normaliseMath(text)}
      </ReactMarkdown>
    </div>
  );
}
