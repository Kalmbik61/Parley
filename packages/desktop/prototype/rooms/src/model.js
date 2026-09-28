/* global crypto, structuredClone */
export const VERSION = 2;
export const providerLabel = { claude: "Claude Code", codex: "Codex" };
export const artifactContent = {
  "refund-contract.md": {
    title: "Refund contract",
    kind: "Decision brief",
    author: "S01 · Architect",
    body: "## Partial refunds\n\nA refund always belongs to the original payment. The amount is expressed in the payment currency and cannot exceed the remaining refundable balance.\n\n### Agreed behavior\n\n- Return `RefundTooLarge` when the amount exceeds the remaining balance.\n- Use an idempotency key for every refund request.\n- Execute balance validation and the refund record in one transaction.\n- A retry with the same key returns the original result.\n\n### Open question, resolved\n\nThe first draft compared against the original payment amount. Review identified that a second partial refund could exceed the remaining balance. Revision 2 uses the remaining balance.\n\n### Handoff\n\nBackend implements the contract. Review checks transaction boundaries. QA covers retries, concurrent requests and a second partial refund.",
  },
  "refund-analysis.md": {
    title: "Existing payment flow",
    kind: "Research",
    author: "S02 · Backend",
    body: "## Existing payment flow\n\n`refund.ts` already delegates to the payment repository. The refund table has a unique payment + idempotency-key index.\n\n### What can be reused\n\n- Existing transaction helper in `payments/repository.ts`.\n- Existing `Money` value object: integer minor units and currency.\n- Existing provider retry policy.\n\n### Change boundary\n\nKeep the public endpoint unchanged. Add remaining-balance validation inside the transaction. Add a regression case for a second partial refund.\n\n### Shared with\n\nArchitect uses this analysis in the decision brief. Reviewer and QA inherit it in their session context.",
  },
  "test-plan.md": {
    title: "Refund test plan",
    kind: "Verification plan",
    author: "S04 · QA",
    body: "## Refund test plan\n\n### Acceptance criteria\n\n- A valid partial refund succeeds in the original currency.\n- Refunding more than the remaining balance returns `RefundTooLarge`.\n- The same idempotency key cannot create two refunds.\n- Two concurrent requests cannot exceed the remaining balance.\n- A second partial refund uses the updated balance.\n\n### Evidence to collect\n\nUnit test output, the integration test report, and the reviewed commit. A plan is not evidence of a passing test.",
  },
};

export function createInitialState() {
  return {
    version: VERSION,
    workspaces: [
      {
        id: "payments",
        title: "Payments",
        project: "shop",
        branch: "main",
        goal: "Add safe partial refunds to the payment flow.",
      },
      {
        id: "auth",
        title: "Authorization",
        project: "shop",
        branch: "feat/auth",
        goal: "Improve sign-in and document the token lifecycle.",
      },
      {
        id: "release",
        title: "Release 1.2",
        project: "shop",
        branch: "release/1.2",
        goal: "Prepare the next release and check the migration.",
      },
    ],
    sessions: [
      {
        id: "pay-s1",
        code: "S01",
        workspace: "payments",
        role: "Architect",
        provider: "claude",
        task: "Coordinate the refund contract",
        status: "waiting",
        scope: "docs/refund-contract.md",
        contextFrom: [],
        result: "Plan ready",
      },
      {
        id: "pay-s2",
        code: "S02",
        workspace: "payments",
        role: "Backend",
        provider: "claude",
        task: "Implement the remaining-balance check",
        status: "waiting",
        scope: "src/payments/refund.ts",
        contextFrom: ["pay-s1"],
        result: "Analysis shared",
      },
      {
        id: "pay-s3",
        code: "S03",
        workspace: "payments",
        role: "Reviewer",
        provider: "codex",
        task: "Review transaction and retry behavior",
        status: "idle",
        scope: "Review only",
        contextFrom: ["pay-s1", "pay-s2"],
        result: "Concern resolved",
      },
      {
        id: "pay-s4",
        code: "S04",
        workspace: "payments",
        role: "QA",
        provider: "codex",
        task: "Verify retries and concurrent refunds",
        status: "queued",
        scope: "tests/refunds.spec.ts",
        contextFrom: ["pay-s1", "pay-s2"],
        result: "Test plan ready",
      },
      {
        id: "auth-s1",
        code: "S01",
        workspace: "auth",
        role: "Planner",
        provider: "claude",
        task: "Describe the sign-in flow",
        status: "idle",
        scope: "docs/auth.md",
        contextFrom: [],
        result: "Research ready",
      },
      {
        id: "auth-s2",
        code: "S02",
        workspace: "auth",
        role: "Docs",
        provider: "codex",
        task: "Document token rotation",
        status: "done",
        scope: "docs/tokens.md",
        contextFrom: ["auth-s1"],
        result: "Summary shared",
      },
    ],
    rooms: [
      {
        id: "refunds",
        workspace: "payments",
        title: "Refunds",
        creator: "pay-s1",
        lead: "pay-s1",
        members: ["pay-s1", "pay-s2", "pay-s3", "pay-s4"],
        goal: "Design partial refunds, agree on the contract, then implement it.",
        stage: "awaiting",
        revision: 2,
        feedback: "",
        conditions: [],
        proposal: {
          title: "A safe contract for partial refunds",
          text: "Возврат — в валюте платежа, в пределах оставшегося баланса. Повторный запрос с тем же ключом не создаёт новый возврат.",
          points: [
            "Balance check inside the transaction",
            "Separate implementation and review",
            "Retries and concurrency covered by QA",
          ],
        },
        plan: [
          {
            sessionId: "pay-s1",
            phase: "planning",
            title: "Define the refund contract",
            scope: "docs/refund-contract.md",
            after: [],
          },
          {
            sessionId: "pay-s2",
            title: "Implement the remaining-balance check",
            scope: "src/payments/refund.ts",
            after: ["pay-s1"],
          },
          {
            sessionId: "pay-s3",
            title: "Review transaction and retry behavior",
            scope: "Review only",
            after: ["pay-s2"],
          },
          {
            sessionId: "pay-s4",
            title: "Verify retries and concurrent refunds",
            scope: "tests/refunds.spec.ts",
            after: ["pay-s2"],
          },
        ],
        decisions: [],
        artifacts: ["refund-contract.md", "refund-analysis.md", "test-plan.md"],
        messages: [
          {
            id: "m1",
            from: "human",
            time: "10:42",
            text: "Нужны частичные возвраты. Сначала согласуйте поведение и зоны ответственности. К реализации перейдём после моего решения.",
          },
          {
            id: "m2",
            from: "pay-s2",
            time: "10:46",
            text: "Проверил платёжный поток. Переиспользуем существующую транзакцию и ключ идемпотентности. Аналитику положил в общий контекст.",
            artifact: "refund-analysis.md",
          },
          {
            id: "m3",
            from: "pay-s3",
            time: "10:49",
            text: "В первом плане есть риск: второй возврат сравнивается с исходной суммой, а не с остатком. Предлагаю проверять remainingBalance внутри транзакции.",
            tag: "Concern raised",
          },
          {
            id: "m4",
            from: "pay-s1",
            time: "10:52",
            text: "Учёл замечание в revision 2. Проверка — по остатку и в той же транзакции. Области изменений разделены; ревью начнётся после Backend.",
            tag: "Concern resolved",
          },
        ],
      },
      {
        id: "signin",
        workspace: "auth",
        title: "Sign-in flow",
        creator: "human",
        lead: "auth-s1",
        members: ["auth-s1", "auth-s2"],
        goal: "Review the sign-in flow and preserve the findings for implementation.",
        stage: "discussion",
        revision: 1,
        feedback: "",
        conditions: [],
        proposal: null,
        plan: [],
        decisions: [],
        artifacts: [],
        messages: [
          {
            id: "a1",
            from: "human",
            time: "Yesterday",
            text: "Разберите авторизацию и сохраните ограничения по ротации токенов. Пока только исследование.",
          },
          {
            id: "a2",
            from: "auth-s2",
            time: "11:14",
            text: "Описал жизненный цикл токенов. Резюме сессии доступно команде; готов передать контекст при старте реализации.",
          },
        ],
      },
    ],
  };
}

export function transitionRoom(room, action) {
  const stamp = () =>
    new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
  const system = (text) => ({
    id: crypto.randomUUID(),
    from: "system",
    time: stamp(),
    text,
  });
  if (action.type === "propose" && room.stage === "discussion") {
    const sessions = (action.sessions || []).filter((s) =>
      room.members.includes(s.id),
    );
    return {
      ...room,
      stage: "awaiting",
      proposal: {
        title: `Plan for ${room.title}`,
        text:
          room.goal ||
          "Clarify the goal, divide responsibilities and return a verifiable result.",
        points: [
          "Agree on inputs, constraints and completion criteria",
          "Assign a separate scope to each contributor",
          "Share findings and review the result before acceptance",
        ],
      },
      plan: sessions.map((s) => ({
        sessionId: s.id,
        phase: s.id === room.lead ? "planning" : "execution",
        title:
          s.id === room.lead
            ? "Define scope and assignments"
            : s.role === "Reviewer"
              ? "Independently review the result"
              : `Contribute ${s.role.toLowerCase()} work`,
        scope:
          s.scope === "Not assigned"
            ? "Scope to be agreed with the lead"
            : s.scope,
        after: s.id === room.lead ? [] : [room.lead],
      })),
      messages: [
        ...room.messages,
        system("You requested a proposal."),
        {
          id: crypto.randomUUID(),
          from: room.lead,
          time: stamp(),
          text: "Предлагаю сначала зафиксировать ограничения и результат, затем распределить отдельную область каждому участнику. План и условия сохранятся в решении комнаты.",
          tag: "Sample proposal",
        },
      ],
    };
  }
  if (action.type === "approve" && room.stage === "awaiting") {
    const conditions = [...(room.conditions || [])];
    const proposal = structuredClone(
      room.proposal || { title: room.title, text: room.goal, points: [] },
    );
    return {
      ...room,
      stage: "ready",
      decisions: [
        ...room.decisions,
        {
          revision: room.revision,
          status: "approved",
          text: [
            proposal.text,
            ...conditions.map((text) => `Requested condition: ${text}`),
          ].join("\n\n"),
          proposal,
          conditions,
          plan: structuredClone(room.plan || []),
          at: stamp(),
        },
      ],
      messages: [
        ...room.messages,
        system(
          `You approved revision ${room.revision}. Implementation has not started.`,
        ),
      ],
    };
  }
  if (action.type === "start" && room.stage === "ready") {
    return {
      ...room,
      stage: "executing",
      messages: [
        ...room.messages,
        system("You started implementation of the approved plan."),
      ],
    };
  }
  if (
    action.type === "return" &&
    room.stage === "awaiting" &&
    action.note?.trim()
  ) {
    return {
      ...room,
      stage: "revising",
      feedback: action.note.trim(),
      decisions: [
        ...room.decisions,
        {
          revision: room.revision,
          status: "returned",
          text: action.note.trim(),
          at: stamp(),
        },
      ],
      messages: [
        ...room.messages,
        {
          id: crypto.randomUUID(),
          from: "human",
          to: [room.lead],
          time: stamp(),
          text: action.note.trim(),
          tag: "Returned for rework",
        },
      ],
    };
  }
  if (action.type === "revised" && room.stage === "revising") {
    return {
      ...room,
      stage: "awaiting",
      revision: room.revision + 1,
      conditions: [...(room.conditions || []), room.feedback],
      messages: [
        ...room.messages,
        {
          id: crypto.randomUUID(),
          from: room.lead,
          time: stamp(),
          text: `Добавил к плану ваше условие: «${room.feedback}». Условие сохранено в новой ревизии решения.`,
          tag: "Plan revised",
        },
      ],
    };
  }
  if (action.type === "finish" && room.stage === "review") {
    return {
      ...room,
      stage: "complete",
      messages: [
        ...room.messages,
        system(
          "You accepted the result. The room remains available as shared context.",
        ),
      ],
    };
  }
  return room;
}

export function assignmentState(room, session, task = {}) {
  if (
    task.phase === "planning" &&
    ["ready", "executing", "review", "complete"].includes(room.stage)
  )
    return { label: "Done", tone: "done" };
  if (["review", "complete"].includes(room.stage) || session.status === "done")
    return { label: "Done", tone: "done" };
  if (["awaiting", "ready", "revising"].includes(room.stage))
    return { label: "Planned", tone: "" };
  return {
    label:
      {
        working: "Working",
        blocked: "Needs input",
        queued: "Waiting",
        waiting: "Waiting",
        idle: "Idle",
      }[session.status] || "Planned",
    tone:
      session.status === "blocked"
        ? "attention"
        : session.status === "working"
          ? "done"
          : "",
  };
}

export function stageLabel(stage) {
  return (
    {
      discussion: "Discussing",
      awaiting: "Needs your decision",
      revising: "Revising plan",
      ready: "Ready to start",
      executing: "In progress",
      review: "Ready for review",
      complete: "Completed",
    }[stage] || stage
  );
}
