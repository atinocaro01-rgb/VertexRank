// Tiny text helper shared by the article pipeline: model output is shown as plain text and exported as markdown, but any raw HTML
// tags in it are removed so a draft can never carry a script or markup into a page by accident.
export const stripHtml = (s) => String(s || "").replace(/<\s*(script|style|iframe)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "").replace(/<\/?[a-z][^>]*>/gi, "");
