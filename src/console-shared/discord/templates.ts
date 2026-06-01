export * from "./template-data/types";
export { fullCreatorCommunityDiscordTemplate } from "./template-data/fullCreator";
export { streamerCommunityDiscordTemplate } from "./template-data/streamerCommunity";
export { leanLiveAlertsDiscordTemplate } from "./template-data/leanLiveAlerts";
export { contentClipsHubDiscordTemplate } from "./template-data/contentClipsHub";
export { eventsGameNightsDiscordTemplate } from "./template-data/eventsGameNights";

import { fullCreatorCommunityDiscordTemplate } from "./template-data/fullCreator";
import { streamerCommunityDiscordTemplate } from "./template-data/streamerCommunity";
import { leanLiveAlertsDiscordTemplate } from "./template-data/leanLiveAlerts";
import { contentClipsHubDiscordTemplate } from "./template-data/contentClipsHub";
import { eventsGameNightsDiscordTemplate } from "./template-data/eventsGameNights";

export const discordSetupTemplates = [
  fullCreatorCommunityDiscordTemplate,
  streamerCommunityDiscordTemplate,
  leanLiveAlertsDiscordTemplate,
  contentClipsHubDiscordTemplate,
  eventsGameNightsDiscordTemplate,
] as const;

export const [defaultDiscordSetupTemplate] = discordSetupTemplates;

export const getDiscordSetupTemplate = (templateId?: string) =>
  discordSetupTemplates.find((template) => template.id === templateId) ??
  defaultDiscordSetupTemplate;
