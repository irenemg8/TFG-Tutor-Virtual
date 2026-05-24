import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import "katex/dist/katex.min.css";

// remark-math reconoce $...$ y $$...$$. Los modelos LLM (Qwen, Llama) suelen
// emitir LaTeX en formato \( ... \) y \[ ... \] (inline / display). Si no lo
// pre-procesamos aparece tal cual ("¿de qué resistencias depende \( V(N2,0) \)?")
// que es justo el bug que veía el estudiante en chat.
function normalizeLatex(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `$$${body}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body}$`);
}

// Schema permisivo para markdown + KaTeX. Heredamos el default de
// rehype-sanitize y añadimos los nodos/atributos que KaTeX inyecta para
// renderizar las fórmulas; sin esto se "limpian" y la fórmula desaparece.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes["*"] || []), "className", "style"],
    span: [...((defaultSchema.attributes && defaultSchema.attributes.span) || []), "className", "style"],
    math: ["xmlns"],
    annotation: ["encoding"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    // KaTeX HTML output
    "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext",
    "mfrac", "msup", "msub", "msubsup", "msqrt", "mroot", "mtable",
    "mtr", "mtd", "annotation",
  ],
};

export default function MessageRenderer({ content }) {
  const normalized = normalizeLatex(content || "");
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeSanitize, sanitizeSchema]]}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
