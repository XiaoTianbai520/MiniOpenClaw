// openai

import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
    baseURL: process.env['OPENAI_BASE_URL'] // This is the default and can be omitted
});

const response = await client.responses.create({
    model: 'deepseek-flash',
    instructions: 'You are a helpful assistant that answers questions about JavaScript.',
    input: '你好'
});

console.log(response.output_text)