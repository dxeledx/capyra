// 插件只依赖公开的对象协议，无需构建步骤或额外运行时依赖。
export default {
  apiVersion: 1,
  id: 'word-count',
  version: '1.0.0',
  title: 'Text counter',
  description: 'Count words, characters and lines in text supplied by the user.',
  permissions: [],
  instructions: 'Use count_text when the user asks for text length. Pass the text exactly as supplied. Words use Unicode word segmentation; punctuation and whitespace do not count as words. An empty input has zero lines.',
  setup(context) {
    context.registerTool({
      name: 'count_text',
      title: 'Count text',
      description: 'Count Unicode words, characters and lines without reading files or accessing the network.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 1000000, description: 'The exact text to count.' } },
        required: ['text'],
        additionalProperties: false,
      },
      effect: 'read',
      permissions: [],
      async preview({ text }) {
        return { title: 'Count text', description: `Count the supplied text (${Array.from(text).length} Unicode code points).` };
      },
      async execute({ text }) {
        // Intl.Segmenter 同时处理中文等无空格语言与英文，避免简单空格切分漏计。
        const words = Array.from(new Intl.Segmenter('und', { granularity: 'word' }).segment(text)).filter(part => part.isWordLike).length;
        const counts = { words, characters: Array.from(text).length, lines: text.length ? text.split(/\r\n|\r|\n/).length : 0 };
        return { content: [{ type: 'text', text: JSON.stringify(counts) }], structuredContent: counts };
      },
    });
  },
};
