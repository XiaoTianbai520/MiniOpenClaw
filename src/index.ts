// openai

import OpenAI from 'openai';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
    baseURL: process.env['OPENAI_BASE_URL'] // This is the default and can be omitted
});

const MODEL = 'deepseek-flash';
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 4000;

const instructions = [
    '你是一个可以操作命令行的助手。',
    '需要事实依据（文件列表、文件内容、进程、版本号等）时，调用 run_command 工具去查，不要凭记忆猜。',
    `当前环境：Windows，命令由 cmd.exe 执行，工作目录是 ${process.cwd()}。`,
    '不要执行破坏性命令，除非用户明确要求。'
].join('\n');

// 告诉模型"能用什么工具"，参数用 JSON Schema 描述
const tools = [
    {
        type: 'function' as const,
        name: 'run_command',
        description: '在项目工作目录下执行一条命令行命令，返回 stdout/stderr。Windows cmd 语法，列目录用 dir。',
        strict: true,
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的完整命令，例如 dir /b 或 node -v' }
            },
            required: ['command'],
            additionalProperties: false
        }
    }
];

const execAsync = promisify(exec);

// Windows 上 cmd 的中文输出常是 GBK，直接按 utf8 解会变乱码
function decode(buffer: Buffer): string {
    const utf8 = new TextDecoder('utf-8').decode(buffer);
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
        return new TextDecoder('gbk').decode(buffer);
    } catch {
        return utf8;
    }
}

function clip(text: string): string {
    return text.length > MAX_OUTPUT_CHARS
        ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出过长已截断)`
        : text;
}

// 明显会毁机器的命令直接拒绝，模型收到拒绝原因后会自己换一种做法
const BLOCKED = [/(^|\s)format\s+[a-z]:/i, /rm\s+-rf\s+\/(\s|$)/i, /del\s+\/[fsq]\s+[a-z]:\\?\s*$/i, /rd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, /shutdown\s+\/[sr]/i, /diskpart/i];

async function runCommand(command: string): Promise<string> {
    if (BLOCKED.some((pattern) => pattern.test(command))) {
        return '拒绝执行：这条命令具有破坏性，请换一种更安全的方式。';
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            timeout: TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'buffer',
            windowsHide: true
        });

        const out = decode(stdout).trim();
        const err = decode(stderr).trim();
        const parts = [out && `stdout:\n${out}`, err && `stderr:\n${err}`].filter(Boolean);
        return clip(parts.join('\n') || '(命令执行成功，无输出)');
    } catch (error) {
        const e = error as { code?: number | string; killed?: boolean; signal?: string; stdout?: Buffer; stderr?: Buffer; message?: string };

        if (e.killed && e.signal) {
            return `命令超过 ${TIMEOUT_MS / 1000} 秒被终止。`;
        }

        const out = e.stdout ? decode(e.stdout).trim() : '';
        const err = e.stderr ? decode(e.stderr).trim() : '';
        const detail = [out && `stdout:\n${out}`, err && `stderr:\n${err}`].filter(Boolean).join('\n');
        return clip(`退出码：${e.code ?? 'unknown'}${detail ? `\n${detail}` : `\n${e.message ?? ''}`}`);
    }
}

const history: ResponseInputItem[] = [];

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
    const roundStart = history.length - 1; // 这一轮的起点，出错时整轮回滚

    try {
        let answer = '';

        // 一问可能触发多次工具调用（查完目录还想看文件内容），所以这里要循环到模型不再要工具为止
        for (;;) {
            const response = await client.responses.create({
                model: MODEL,
                instructions,
                tools,
                input: history
            });

            // 把模型这一轮的输出（消息 / function_call）整体追加进上下文，下一轮才能接上
            history.push(...(response.output as unknown as ResponseInputItem[]));

            let handledCall = false;

            for (const item of response.output) {
                if (item.type !== 'function_call') continue;
                handledCall = true;

                let command = '';
                try {
                    command = (JSON.parse(item.arguments || '{}') as { command?: string }).command ?? '';
                } catch {
                    // 参数不是合法 JSON 时，把错误原样告诉模型，让它重试
                    history.push({
                        type: 'function_call_output',
                        call_id: item.call_id,
                        output: `参数解析失败，收到的原始参数是：${item.arguments}`
                    });
                    continue;
                }

                console.log(`\n$ ${command}`);
                const result = await runCommand(command);
                console.log(result.split('\n').slice(0, 15).join('\n'));

                // 用 call_id 把"这次输出"对上是哪个调用
                history.push({
                    type: 'function_call_output',
                    call_id: item.call_id,
                    output: result
                });
            }

            if (!handledCall) {
                answer = response.output_text ?? '';
                break;
            }
        }

        // response.output 里已经含最终的 assistant 消息，不用再手动追加
        if (process.env['DEBUG_HISTORY'] === 'true') {
            console.log('\ndebug: history', history);
        }

        console.log(`\nAI：${answer}`);
    } catch (error) {
        history.length = roundStart; // 整轮回滚，别把半截上下文留给下一轮
        console.error('\n请求失败：', error instanceof Error ? error.message : error);
    }

    rl.prompt();
}

rl.close();
console.log('再见。');
