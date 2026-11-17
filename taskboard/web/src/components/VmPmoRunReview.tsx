import { useTaskboardI18n } from "../i18n";
import type { VmPmoQaItem, VmPmoRunReview as Review } from "../types";

const DISPOSITIONS: Record<string, [string, string]> = {
  operation: ["执行", "Edited"],
  constraint: ["约束", "Constraint"],
  context: ["说明", "Context"],
  unsupported: ["做不到", "Unsupported"],
  needs_evidence: ["缺证据", "Needs evidence"],
  ambiguous: ["有歧义", "Ambiguous"],
};

function seconds(value: number | null): string {
  return value === null ? "" : `${(value / 1_000_000).toFixed(2)}s`;
}

function QaList({ items, label }: { items: VmPmoQaItem[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="vm-pmo-review-list" aria-label={label}>
      {items.map((item, index) => (
        <li key={`${item.checkId ?? "check"}-${index}`}>
          <code>{item.kind}</code>
          {item.targetStartUs !== null && (
            <span>{seconds(item.targetStartUs)}{item.targetEndUs !== null && item.targetEndUs !== item.targetStartUs
              ? `–${seconds(item.targetEndUs)}` : ""}</span>
          )}
          <span>{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** v3 approval view: how the AI intent covered each instruction, why planning blocked, and which
 * QA checks still need a person. `overall: failed` never reaches delivery; this view only explains. */
export function VmPmoRunReview({ review }: { review: Review }) {
  const { text } = useTaskboardI18n();
  const qa = review.qa;
  return (
    <div className="vm-pmo-review" aria-label={text("规划与成片检查", "Plan and video checks")}>
      {review.planningMode && (
        <div className="vm-pmo-run-meta">
          <span>{review.planningMode === "ai_intent" ? text("AI 意图规划", "AI intent planning")
            : text("固定句式规划", "Rule-based planning")}</span>
        </div>
      )}
      {review.coverage.length > 0 && (
        <table className="vm-pmo-review-coverage" aria-label={text("意见覆盖", "Instruction coverage")}>
          <thead>
            <tr><th>{text("意见片段", "Instruction span")}</th><th>{text("处理", "Handling")}</th>
              <th>{text("说明", "Reason")}</th></tr>
          </thead>
          <tbody>
            {review.coverage.map((row, index) => {
              const label = row.disposition ? DISPOSITIONS[row.disposition] : undefined;
              return (
                <tr key={index}>
                  <td>{row.quote}</td>
                  <td>{label ? text(label[0], label[1]) : row.disposition}</td>
                  <td>{row.reason}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {review.blockers.length > 0 && (
        <ul className="vm-pmo-review-list" aria-label={text("规划阻断原因", "Planning blockers")}>
          {review.blockers.map((row, index) => (
            <li key={index}>
              {row.code && <code className="vm-pmo-run-error-code">{row.code}</code>}
              {row.rule && <code>{row.rule}</code>}
              <span>{row.message}</span>
              {row.quotes.length > 0 && <span>「{row.quotes.join("」「")}」</span>}
              {row.missingEvidence.length > 0 && (
                <span>{text("缺少证据：", "Missing evidence: ")}{row.missingEvidence.join("、")}</span>
              )}
              {row.candidateCount > 0 && (
                <span>{text(`${row.candidateCount} 个候选位置`, `${row.candidateCount} candidate locations`)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {qa && (
        <div aria-label={text("成片质量检查", "Video QA")}>
          <div className="vm-pmo-run-meta">
            <span>{qa.overall === "failed" ? text("成片检查未通过，不会交付", "Video QA failed; it will not be delivered")
              : text("成片检查完成，仍需人工复核下列项目", "Video QA ran; a person still has to check the items below")}</span>
            {!qa.reverseAsr && <span>{text("未做成片反向识别", "No reverse speech recognition")}</span>}
          </div>
          <QaList items={qa.failed} label={text("未通过的检查", "Failed checks")} />
          <QaList items={qa.needsHuman} label={text("需要人工复核", "Needs human review")} />
        </div>
      )}
    </div>
  );
}
