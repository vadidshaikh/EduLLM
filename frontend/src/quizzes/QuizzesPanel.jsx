import { useState } from "react";
import { smoothly } from "../ui/transition";
import AssessmentsPanel from "./AssessmentsPanel";
import QuestionBank from "./QuestionBank";

/**
 * A shared workspace's "Quizzes" tab: the question bank, and the quizzes
 * and assignments made from it for each classroom.
 */
export default function QuizzesPanel({ token, workspace, classrooms }) {
  const [part, setPart] = useState("bank");
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
        </div>
      </div>
      {part === "bank" ? (
        <QuestionBank token={token} workspace={workspace} />
      ) : (
        <AssessmentsPanel token={token} workspace={workspace} classrooms={classrooms} />
      )}
    </>
  );
}
