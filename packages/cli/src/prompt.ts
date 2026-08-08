import { createInterface } from "node:readline";

/** 한 줄 입력을 받는다. */
export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 비밀번호 입력. 화면에 찍히지 않게 출력을 막는다.
 *
 * readline 이 에코를 직접 끄는 방법을 노출하지 않아서, 내부 출력 훅을
 * 가로채는 관용적인 방법을 쓴다.
 */
export function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  let muted = false;
  const target = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = target._writeToOutput?.bind(rl);
  target._writeToOutput = (text: string) => {
    if (!muted) {
      original?.(text);
      return;
    }
    // 질문 자체는 보여주고 입력만 가린다.
    if (text.includes(question)) original?.(question);
  };

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}
