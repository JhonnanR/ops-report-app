import "server-only";
import propsJson from "./notion-props.json";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  get notionToken() {
    return required("NOTION_TOKEN");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get supervisorsDb() {
    return required("NOTION_SUPERVISORS_DB");
  },
  get projectsDb() {
    return required("NOTION_PROJECTS_DB");
  },
  get buildingsDb() {
    return required("NOTION_BUILDINGS_DB");
  },
  get elevationsDb() {
    return required("NOTION_ELEVATIONS_DB");
  },
  get showTestElevations() {
    return process.env.SHOW_TEST_ELEVATIONS === "true";
  },
  get sessionHours() {
    const n = Number(process.env.SESSION_HOURS ?? "12");
    return Number.isFinite(n) && n > 0 ? n : 12;
  },
};

/**
 * Notion property keys, loaded from lib/notion-props.json.
 * After `npm run notion:ids` these are property IDs, which stay the same
 * when a column is renamed in Notion. (Names also work, as a fallback.)
 */
export const props = {
  supervisors: propsJson.supervisors,
  projects: propsJson.projects,
  buildings: propsJson.buildings,
  elevations: propsJson.elevations,
};