// openai

import OpenAI from 'openai';
import { createInterface } from 'node:readline/promises';

const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
    baseURL: process.env['OPENAI_BASE_URL'] // This is the default and can be omitted
});

type Message = {
    role: 'user' | 'assistant';
    content: string;
};

const instructions = 'You are a helpful assistant that answers questions about JavaScript.';
const history: Message[] = [];

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log('输入问题后回车；exit 退出，clear 清空上下文。');

rl.setPrompt('\n你：');
rl.prompt();

// 用 for await 逐行读，输入不会丢，Ctrl+D / Ctrl+C 也能自然退出
for await (const line of rl) {
    const question = line.trim();

    if (!question) {
        rl.prompt();
        continue;
    }
    if (question === 'exit' || question === 'quit') break;

    if (question === 'clear') {
        history.length = 0;
        console.log('已清空上下文。');
        rl.prompt();
        continue;
    }

    history.push({ role: 'user', content: question });

    try {
        const response = await client.responses.create({
            model: 'deepseek-flash',
            instructions,
            input: history
        });

        const reply = response.output_text ?? '';
        history.push({ role: 'assistant', content: reply });
        
        if (process.env['DEBUG_HISTORY'] === 'true') {
            console.log("\ndebug: history", history);
        }
        
        console.log(`\nAI：${reply}`);
    } catch (error) {
        history.pop(); // 请求失败就撤回这一问，别把半截上下文留给下一轮
        console.error('\n请求失败：', error instanceof Error ? error.message : error);
    }

    rl.prompt();
}

rl.close();
console.log('再见。');
