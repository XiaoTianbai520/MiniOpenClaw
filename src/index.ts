// openai

import OpenAI from 'openai';
import { createInterface } from 'node:readline/promises';

const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
    baseURL: process.env['OPENAI_BASE_URL'] // This is the default and can be omitted
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const question = (await rl.question('请输入你的问题：')).trim();
rl.close();

const response = await client.responses.create({
    model: 'deepseek-flash',
    instructions: 'You are a helpful assistant that answers questions about JavaScript.',
    input: question 
});

console.log(response.output_text)