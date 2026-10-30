import { useEffect, useState } from "react";
import { smoothly } from "../ui/transition";
import AnalyticsPanel from "./AnalyticsPanel";
import AssessmentsPanel from "./AssessmentsPanel";
import QuestionBank from "./QuestionBank";

/**
 * A shared workspace's "Quizzes" tab: the question bank, the quizzes and
 * assignments made from it for each classroom, and how each classroom is
 * doing on them. `focus` ({quiz, classroomId}, from a link) opens that quiz.
 */
export default function QuizzesPanel({ token, workspace, classrooms, focus }) {
  const [part, setPart] = useState(focus ? "sets" : "bank");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening what a link points at
    if (focus) setPart("sets");
  }, [focus]);
  return (
    <>
      <div className="lib-tools">
        <div className="seg" role="group" aria-label="Show">
          <button aria-pressed={part === "bank"} onClick={() => part !== "bank" && smoothly(() => setPart("bank"))}>
            Question bank
          </button>
          <button aria-pressed={part === "sets"} onClick={() => part !== "sets" && smoothly(() => setPart("sets"))}>
            Quizzes &amp; assignments
          </button>
          <button aria-pressed={part === "stats"} onClick={() => part !== "stats" && smoothly(() => setPart("stats"))}>
            Analytics
          </button>
        </div>
      </div>
      {part === "bank" && <QuestionBank token={token} workspace={workspace} />}
      {part === "sets" && <AssessmentsPanel token={token} workspace={workspace} classrooms={classrooms} focus={focus} />}
      {part === "stats" && <AnalyticsPanel token={token} classrooms={classrooms} />}
    </>
  );
}
