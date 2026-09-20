import { ALL_PROJECTS } from '@orc/api-contract';
import { useEffect } from 'react';
import { useProjects } from '@/api/queries/projects.ts';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useProjectStore } from '@/stores/project.ts';

export function ProjectSelector() {
  const { data: projects } = useProjects();
  const projectId = useProjectStore((s) => s.projectId);
  const setProjectId = useProjectStore((s) => s.setProjectId);

  useEffect(() => {
    if (!projects || projectId === ALL_PROJECTS) return;
    if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0]?.id ?? ALL_PROJECTS);
  }, [projects, projectId, setProjectId]);

  const visible = (projects ?? []).filter((p) => !p.hidden || p.id === projectId);
  return (
    <NativeSelect aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
      {visible.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.sessionCount})
        </option>
      ))}
      <option value={ALL_PROJECTS}>All projects</option>
    </NativeSelect>
  );
}
