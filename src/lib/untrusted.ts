// LLM 프롬프트에 비신뢰 입력을 delimiter 블록으로 넣을 때, 입력이 닫힘/열림 토큰을 위조해
// 블록을 조기 종료하고 그 뒤 텍스트를 '시스템 지시'처럼 보이게 하는 탈출(delimiter injection)을 차단.

// 알려진 비신뢰 블록 토큰을 입력에서 제거 — 위조된 [/UNTRUSTED_…]·[CONTEXT] 등으로 블록을 깨지 못하게.
// #58: NFKC 정규화(fullwidth ［／ → ASCII) + zero-width/format 문자(\p{Cf}) 제거 후 매칭 → Unicode 우회 차단.
export function stripDelimiterTokens(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\[\/?(?:UNTRUSTED_[A-Z_]*|CONTEXT)\]/gi, '');
}

// 비신뢰 본문을 안전하게 delimiter 블록으로 감싼다(토큰 위조 제거 포함).
export function untrustedBlock(tag: string, body: unknown): string {
  return `[${tag}]\n${stripDelimiterTokens(body)}\n[/${tag}]`;
}
