import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPrefs } from "../components/prefs/ProjectsPrefs";

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsPrefs,
});
