import type { Step } from './useAgentRun';

type StepListProps = { steps: Step[] }

export function StepList( { steps } : StepListProps ) {
  if(steps.length === 0) return <p>No steps yet!</p>

  return (
    <ol>
      {steps.map((step) => (
        <li key={ step.index }>
          <strong>{ step.kind }</strong> - {step.status}
          {step.errorCode && (
            <span style={{ color: 'red' }}> ({ step.errorCode }) </span>
          )}
        </li>
      ))}
    </ol>
  )
}
