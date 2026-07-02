// 서버 부팅 훅 — 재시작/재배포 시 진행 중이던(running/finalizing) 회의를 이어서 완주.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const g = globalThis as typeof globalThis & { __quorumWatchdogStarted?: boolean };
  if (g.__quorumWatchdogStarted) return;
  g.__quorumWatchdogStarted = true;
  // agent_configs는 DB 단독(부트스트랩: sql/agent-configs-seed.sql 1회 실행) — 부팅 시드 없음.
  const { resumeStuckMeetings, resumeStuckDirectives, resumePendingReflections } = await import('@/lib/meeting-runner');
  const runWatchdog = () => {
    void resumeStuckMeetings();
    void resumeStuckDirectives();
    void resumePendingReflections();
  };
  setTimeout(runWatchdog, 5000);
  const timer = setInterval(runWatchdog, 60_000);
  if (typeof timer === 'object' && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}
