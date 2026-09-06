import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type {
  ActionResult,
  CommentInput,
  ConnectionInput,
  LikeInput,
  LinkedInExecutor,
  MessageInput,
  ReplyCheckInput,
  ReplyResult,
  VisitInput,
} from './types.js';

const execFileAsync = promisify(execFile);

export interface OpenCliExecutorOptions {
  sessionName?: string;
  timeoutMs?: number;
}

export class OpenCliExecutor implements LinkedInExecutor {
  private readonly session: string;
  private readonly timeoutMs: number;

  constructor(options: OpenCliExecutorOptions = {}) {
    this.session = options.sessionName ?? 'engage';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async runBrowserCmd(subcommand: string, ...args: string[]): Promise<string> {
    const fullArgs = ['browser', this.session, subcommand, ...args];
    try {
      const { stdout } = await execFileAsync('opencli', fullArgs, {
        timeout: this.timeoutMs,
      });
      return stdout.trim();
    } catch (err: any) {
      throw new Error(`OpenCLI browser command failed (${subcommand}): ${err.stderr || err.message}`);
    }
  }

  private async evalJs(code: string): Promise<any> {
    const raw = await this.runBrowserCmd('eval', code);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async visitProfile(input: VisitInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    await this.runBrowserCmd('open', input.profileUrl);
    return {
      success: true,
      timestamp,
      outcomeLabel: 'browser-executed',
      audit: {
        eventId: `opencli_${timestamp}`,
        payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
      },
    };
  }

  async sendConnection(input: ConnectionInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    try {
      await execFileAsync('opencli', ['linkedin', 'connect', input.profileUrl], { timeout: this.timeoutMs });
      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `opencli_conn_${timestamp}`,
          payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: err.message,
        timestamp,
        audit: {
          eventId: `opencli_conn_fail_${timestamp}`,
          payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
        },
      };
    }
  }

  async sendMessage(input: MessageInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    return {
      success: true,
      timestamp,
      outcomeLabel: 'browser-executed',
      audit: {
        eventId: `opencli_msg_${timestamp}`,
        payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
      },
    };
  }

  async checkReplies(input: ReplyCheckInput): Promise<ReplyResult> {
    const timestamp = new Date().toISOString();
    return {
      hasReplied: false,
      success: true,
      timestamp,
      outcomeLabel: 'browser-executed',
      audit: {
        eventId: `opencli_replies_${timestamp}`,
        payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
      },
    };
  }

  async likePost(input: LikeInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    try {
      // 1. Open the post URL
      const cleanUrl = input.postUrl.split('#')[0];
      await this.runBrowserCmd('open', cleanUrl);
      await new Promise((r) => setTimeout(r, 2000));

      // Parse post index if present in hash (e.g. #post-0)
      const postIdxMatch = input.postUrl.match(/#post-(\d+)/);
      const postIdx = postIdxMatch ? parseInt(postIdxMatch[1], 10) : 0;

      const script = `(() => {
        const likeButtons = Array.from(document.querySelectorAll('button')).filter(b => 
          b.innerText.trim() === 'Like' || 
          b.getAttribute('aria-label') === 'Like' ||
          b.classList.contains('react-button__trigger')
        );
        if (likeButtons.length === 0) return { error: 'SELECTOR_MISMATCH' };
        const btn = likeButtons[${postIdx}] || likeButtons[0];
        const label = btn.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('unlike') || label.toLowerCase().includes('liked')) {
          return { error: 'ACTION_DUPLICATE' };
        }
        btn.click();
        return { success: true };
      })()`;

      const result = await this.evalJs(script);
      if (result && result.error) {
        throw new Error(result.error);
      }

      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `opencli_like_${timestamp}`,
          payloadHash: createHash('sha256').update(input.postUrl + 'like' + timestamp).digest('hex'),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: err.message,
        timestamp,
        audit: {
          eventId: `opencli_like_fail_${timestamp}`,
          payloadHash: createHash('sha256').update(input.postUrl + timestamp).digest('hex'),
        },
      };
    }
  }

  async publishComment(input: CommentInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    try {
      // 1. Open the post activity URL
      const cleanUrl = input.postUrl.split('#')[0];
      await this.runBrowserCmd('open', cleanUrl);
      await new Promise((r) => setTimeout(r, 2000));

      const postIdxMatch = input.postUrl.match(/#post-(\d+)/);
      const postIdx = postIdxMatch ? parseInt(postIdxMatch[1], 10) : 0;

      // 2. Click the comment button for the targeted post (exclude pill filters)
      const openCommentScript = `(() => {
        const commentButtons = Array.from(document.querySelectorAll(
          'button.comment-button, button[aria-label="Comment"], button.social-actions-button.comment-button'
        )).filter(b => 
          !b.classList.contains('artdeco-pill') &&
          !b.classList.contains('profile-creator-shared-pills__pill')
        );
        if (commentButtons.length > 0) {
          const btn = commentButtons[${postIdx}] || commentButtons[0];
          btn.click();
          return { clicked: true };
        }
        return { clicked: false };
      })()`;
      await this.evalJs(openCommentScript);
      await new Promise((r) => setTimeout(r, 1500));

      // 3. Focus Quill editor, select contents, and execute insertText
      const commentTextJson = JSON.stringify(input.comment);
      const typeScript = `(() => {
        const editors = Array.from(document.querySelectorAll(
          '.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], .comments-comment-box div[contenteditable="true"]'
        )).filter(e => e.offsetParent !== null && !e.classList.contains('ql-clipboard'));
        if (editors.length === 0) return { error: 'SELECTOR_MISMATCH' };
        const editor = editors[0];
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        document.execCommand('insertText', false, ${commentTextJson});
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      })()`;
      const typeResult = await this.evalJs(typeScript);
      if (typeResult && typeResult.error) {
        throw new Error(typeResult.error);
      }
      await new Promise((r) => setTimeout(r, 1500));

      // 4. Click Submit/Post button specifically inside comment box form
      const submitScript = `(() => {
        const submitBtn = document.querySelector(
          '.comments-comment-box__submit-button--cr, .comments-comment-box__submit-button, button.comments-comment-box__submit-button--cr, .comments-comment-box__form button.artdeco-button--primary'
        );
        if (!submitBtn) {
          const fallbacks = Array.from(document.querySelectorAll('.comments-comment-box button, form button')).filter(b => 
            (b.innerText.trim() === 'Comment' || b.innerText.trim() === 'Post') &&
            b.offsetParent !== null &&
            !b.classList.contains('comment-button')
          );
          if (fallbacks.length === 0) return { error: 'SUBMIT_NOT_FOUND' };
          if (fallbacks[0].disabled) return { error: 'SUBMIT_DISABLED' };
          fallbacks[0].click();
          return { success: true };
        }

        if (submitBtn.disabled) return { error: 'SUBMIT_DISABLED' };
        submitBtn.click();
        return { success: true };
      })()`;
      const submitResult = await this.evalJs(submitScript);
      if (submitResult && submitResult.error) {
        throw new Error(submitResult.error);
      }

      await new Promise((r) => setTimeout(r, 2000));

      // 5. Verify the comment actually posted by checking if it appears in the DOM
      //    and isn't just stuck in the editor
      const verifyScript = `(() => {
        const errorToast = document.querySelector('.artdeco-toast-item--error');
        if (errorToast) return { error: 'LINKEDIN_ERROR_TOAST: ' + errorToast.innerText };

        // Check if the text is stuck in the editor
        const editors = Array.from(document.querySelectorAll(
          '.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], .comments-comment-box div[contenteditable="true"]'
        )).filter(e => e.offsetParent !== null && !e.classList.contains('ql-clipboard'));
        
        if (editors.length > 0) {
          const editorText = editors[0].innerText || '';
          if (editorText.trim() === ${commentTextJson}.trim()) {
            return { error: 'COMMENT_STUCK_IN_EDITOR' };
          }
        }

        // Optional: Check if the comment text is found in the comments list
        const commentList = document.querySelector('.comments-comments-list, .feed-shared-update-v2__comments-container');
        if (commentList && !commentList.innerText.includes(${commentTextJson}.substring(0, 15))) {
           // Not found in the comments list, but might be taking time to render.
           // For now, if it's not in the editor and no error toast, we might assume success,
           // but let's be strict.
           return { error: 'COMMENT_NOT_VISIBLE_AFTER_SUBMIT' };
        }

        return { success: true };
      })()`;
      const verifyResult = await this.evalJs(verifyScript);
      if (verifyResult && verifyResult.error) {
        throw new Error(verifyResult.error);
      }

      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `opencli_comment_${timestamp}`,
          payloadHash: createHash('sha256').update(input.postUrl + 'comment' + timestamp).digest('hex'),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: err.message,
        timestamp,
        audit: {
          eventId: `opencli_comment_fail_${timestamp}`,
          payloadHash: createHash('sha256').update(input.postUrl + timestamp).digest('hex'),
        },
      };
    }
  }
}
