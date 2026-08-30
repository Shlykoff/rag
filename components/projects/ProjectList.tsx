import { ProjectCard } from "./ProjectCard";
import type { ProjectListItem } from "./types";

export function ProjectList({ projects }: { projects: ProjectListItem[] }) {
  if (projects.length === 0) {
    return (
      <div className="card empty-state">
        <p>У вас пока нет ни одного проекта.</p>
        <p className="field-hint">
          Создайте первый проект выше, чтобы загрузить документы, выбрать модель и начать задавать
          вопросы — или подключить к нему Telegram-бота для своей аудитории.
        </p>
      </div>
    );
  }

  return (
    <div className="project-grid">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
