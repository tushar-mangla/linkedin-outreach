import { GoogleGenerativeAI } from '@google/generative-ai';
import { IcpCriteria, ProspectInput, IcpScore, IcpScoreSchema } from '../../schemas/icp.js';
import { ICPModelProvider } from './ai-provider.js';

export interface IGeminiClient {
  getGenerativeModel(model: { model: string }): any;
}

export interface GeminiEvaluatorOptions {
  apiKey?: string;
  client?: IGeminiClient;
}

export class GeminiEvaluator implements ICPModelProvider {
  private client: IGeminiClient;
  private apiKey: string;

  constructor(options?: GeminiEvaluatorOptions) {
    this.apiKey = options?.apiKey || process.env.GEMINI_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('Gemini API key is required. Provide it via options or GEMINI_API_KEY env var.');
    }
    this.client = options?.client || new GoogleGenerativeAI(this.apiKey);
  }

  async evaluate(prospect: ProspectInput, criteria: IcpCriteria, retries = 3): Promise<IcpScore> {
    const model = this.client.getGenerativeModel({ model: 'gemini-pro' });
    const prompt = this.constructPrompt(prospect, criteria);

    for (let i = 0; i < retries; i++) {
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const parsed = JSON.parse(text);
        const validatedScore = IcpScoreSchema.parse(parsed);
        return validatedScore;
      } catch (error) {
        console.error(`Gemini evaluation failed (attempt ${i + 1}/${retries}):`, error);
        if (i === retries - 1) {
          throw new Error(`Failed to evaluate prospect with Gemini after ${retries} retries`);
        }
      }
    }
    throw new Error('Gemini evaluation failed unexpectedly.');
  }

  private constructPrompt(prospect: ProspectInput, criteria: IcpCriteria): string {
    const prospectData = JSON.stringify(prospect, null, 2);
    const criteriaData = JSON.stringify(criteria, null, 2);

    return `
      Please evaluate the following prospect based on the provided ICP criteria.
      The response must be a valid JSON object that conforms to the IcpScore schema.

      **ICP Criteria:**
      \`\`\`json
      ${criteriaData}
      \`\`\`

      **Prospect Data:**
      \`\`\`json
      ${prospectData}
      \`\`\`

      Evaluate the prospect against the criteria and respond with only the JSON object.
    `;
  }
}
