import { BrandingProfile } from "../../types/branding";

export interface ButtonSnapshot {
  index: number;
  text: string;
  html: string;
  classes: string;
  background: string;
  textColor: string;
  borderColor?: string | null;
  borderRadius?: string;
  shadow?: string | null;
}

export interface BrandingLLMInput {
  jsAnalysis: BrandingProfile;
  buttons: ButtonSnapshot[];

  screenshot?: string;
  url: string;
}
