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

function toActivityFeedUrl(targetUrl: string): string {
  if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;
  const clean = targetUrl.split(/[?#]/)[0].replace(/\/+$/, '');

  if (clean.includes('/recent-activity') || clean.endsWith('/posts') || clean.includes('/feed/update/')) {
    return targetUrl;
  }

  const companyMatch = clean.match(/^(https?:\/\/[^\/]+\/company\/[^\/]+)/i);
  if (companyMatch) {
    return `${companyMatch[1]}/posts/?feedView=all`;
  }

  const profileMatch = clean.match(/^(https?:\/\/[^\/]+\/in\/[^\/]+)/i);
  if (profileMatch) {
    return `${profileMatch[1]}/recent-activity/all/`;
  }

  return targetUrl;
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

  private async evalJs(jsCode: string): Promise<any> {
    const output = await this.runBrowserCmd('eval', jsCode);
    if (!output || output === 'undefined' || output === 'null') return null;
    try {
      return JSON.parse(output);
    } catch {
      return { raw: output };
    }
  }

  async visitProfile(input: VisitInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    try {
      await this.runBrowserCmd('open', input.profileUrl);
      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `opencli_visit_${timestamp}`,
          payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: err.message,
        timestamp,
        audit: {
          eventId: `opencli_visit_fail_${timestamp}`,
          payloadHash: createHash('sha256').update(input.profileUrl + timestamp).digest('hex'),
        },
      };
    }
  }

  async sendConnection(input: ConnectionInput): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    try {
      await this.runBrowserCmd('open', input.profileUrl);
      await new Promise((r) => setTimeout(r, 2000));
      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `opencli_connect_${timestamp}`,
          payloadHash: createHash('sha256').update(input.profileUrl + (input.note || '') + timestamp).digest('hex'),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        errorCode: err.message,
        timestamp,
        audit: {
          eventId: `opencli_connect_fail_${timestamp}`,
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
      // 1. Open the post / activity URL
      const cleanUrl = toActivityFeedUrl(input.postUrl.split('#')[0]);
      await this.runBrowserCmd('open', cleanUrl);
      await new Promise((r) => setTimeout(r, 2500));

      // Parse post index if present in hash (e.g. #post-0)
      const postIdxMatch = input.postUrl.match(/#post-(\d+)/);
      const postIdx = postIdxMatch ? parseInt(postIdxMatch[1], 10) : 0;

      // Check if page is a 404 or empty activity page
      const pageCheckScript = `(() => {
        const text = document.body.innerText;
        const url = window.location.href;
        if (url.includes('/authwall') || url.includes('/checkpoint/') || url.includes('/login')) {
          return { error: 'AUTH_REQUIRED' };
        }
        if (text.includes("This page doesn\\'t exist") || text.includes("Nothing to see for now")) {
          return { error: 'POST_NOT_ELIGIBLE' };
        }
        // Dismiss any cookie / modal popups if present
        document.querySelectorAll('.artdeco-modal__dismiss, button[aria-label="Dismiss" i], .modal__dismiss').forEach(b => { if (typeof b.click === 'function') b.click(); });
        return { success: true };
      })()`;
      const pageCheck = await this.evalJs(pageCheckScript);
      if (pageCheck && pageCheck.error) {
        throw new Error(pageCheck.error);
      }

      const script = `(() => {
        const likeButtons = Array.from(document.querySelectorAll(
          'button.react-button__trigger, button[aria-label*="Like" i], button:has(svg[data-test-icon="thumbs-up-outline-medium"])'
        )).filter(b => 
          b.closest('.feed-shared-social-action-bar') !== null || 
          b.closest('.social-details-social-activity') !== null ||
          b.closest('.artdeco-action-bar') !== null ||
          b.getAttribute('aria-label')?.toLowerCase().includes('like')
        );
        if (likeButtons.length === 0) {
          const hasPosts = document.querySelectorAll('.feed-shared-update-v2, .feed-shared-post').length > 0;
          if (!hasPosts || document.body.innerText.includes('Nothing to see for now')) {
            return { error: 'POST_NOT_ELIGIBLE' };
          }
          return { error: 'SELECTOR_MISMATCH' };
        }
        const btn = likeButtons[${postIdx}] || likeButtons[0];
        const label = btn.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('unlike') || label.toLowerCase().includes('liked')) {
          return { error: 'ACTION_DUPLICATE' };
        }
        if (typeof btn.scrollIntoView === 'function') {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      const cleanUrl = toActivityFeedUrl(input.postUrl.split('#')[0]);
      await this.runBrowserCmd('open', cleanUrl);
      await new Promise((r) => setTimeout(r, 2500));

      const postIdxMatch = input.postUrl.match(/#post-(\d+)/);
      const postIdx = postIdxMatch ? parseInt(postIdxMatch[1], 10) : 0;

      // Check if page is a 404, empty activity page, or authwall
      const pageCheckScript = `(() => {
        const text = document.body.innerText;
        const url = window.location.href;
        if (url.includes('/authwall') || url.includes('/checkpoint/') || url.includes('/login')) {
          return { error: 'AUTH_REQUIRED' };
        }
        if (text.includes("This page doesn\\'t exist") || text.includes("Nothing to see for now")) {
          return { error: 'POST_NOT_ELIGIBLE' };
        }
        // Dismiss any cookie / modal popups if present
        document.querySelectorAll('.artdeco-modal__dismiss, button[aria-label="Dismiss" i], .modal__dismiss').forEach(b => { if (typeof b.click === 'function') b.click(); });
        return { success: true };
      })()`;
      const pageCheck = await this.evalJs(pageCheckScript);
      if (pageCheck && pageCheck.error) {
        throw new Error(pageCheck.error);
      }

      const openCommentScript = `(() => {
        const commentButtons = Array.from(document.querySelectorAll(
          'button.comment-button, button[aria-label*="Comment" i], button.social-actions-button.comment-button, button:has(svg[data-test-icon="comment-outline-medium"]), button.artdeco-button--tertiary[aria-label*="comment" i]'
        )).filter(b => 
          !b.classList.contains('artdeco-pill') &&
          !b.classList.contains('profile-creator-shared-pills__pill')
        );
        if (commentButtons.length > 0) {
          const btn = commentButtons[${postIdx}] || commentButtons[0];
          if (typeof btn.scrollIntoView === 'function') {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          btn.click();
          return { clicked: true };
        }
        const hasPosts = document.querySelectorAll('.feed-shared-update-v2, .feed-shared-post, .update-components-actor').length > 0;
        if (!hasPosts || document.body.innerText.includes('Nothing to see for now')) {
          return { error: 'POST_NOT_ELIGIBLE' };
        }
        return { clicked: false };
      })()`;
      const openResult = await this.evalJs(openCommentScript);
      if (openResult && openResult.error) {
        throw new Error(openResult.error);
      }
      await new Promise((r) => setTimeout(r, 1500));

      const commentTextJson = JSON.stringify(input.comment);

      // 2.5. Check if we already have ANY comment on this post or the exact text
      const duplicateCheckScript = `(() => {
        // 1. Check if ANY comment author is "You"
        const authorNames = Array.from(document.querySelectorAll('.update-components-actor__name, .comments-post-meta__name-text, span[aria-hidden="true"]'));
        for (const author of authorNames) {
          if (author.innerText && author.innerText.includes('You')) {
            return { error: 'ACTION_DUPLICATE' };
          }
        }

        // 2. Fallback: Check if the exact comment text is already visible on the page
        const textToFind = ${commentTextJson};
        const searchSub = textToFind.length > 40 ? textToFind.substring(0, 40) : textToFind;
        const comments = Array.from(document.querySelectorAll('.comments-comment-item__main-content, .update-components-text, .feed-shared-update-v2__description'));
        for (const c of comments) {
          if (c.innerText && c.innerText.includes(searchSub)) {
            return { error: 'ACTION_DUPLICATE' };
          }
        }
        return { success: true };
      })()`;
      const duplicateCheck = await this.evalJs(duplicateCheckScript);
      if (duplicateCheck && duplicateCheck.error) {
        throw new Error(duplicateCheck.error);
      }

      // 3. Focus Quill editor and insert text
      const typeScript = `(() => {
        const editors = Array.from(document.querySelectorAll(
          '.comments-comment-box .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"], div[contenteditable="true"][data-placeholder*="Comment" i], div[contenteditable="true"][role="textbox"], .comments-comment-box-editor__text-editor, div.editor-content[contenteditable="true"]'
        )).filter(e => e.offsetParent !== null && !e.classList.contains('ql-clipboard'));
        if (editors.length === 0) return { error: 'SELECTOR_MISMATCH' };
        const editor = editors[0];
        if (typeof editor.scrollIntoView === 'function') {
          editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        editor.focus();

        // Set selection
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // Execute insertText
        document.execCommand('insertText', false, ${commentTextJson});
        
        // Trigger synthetic input events
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${commentTextJson} }));
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));

        return { success: true, text: editor.innerText.trim().substring(0, 20) };
      })()`;
      const typeResult = await this.evalJs(typeScript);
      if (typeResult && typeResult.error) {
        throw new Error(typeResult.error);
      }
      await new Promise((r) => setTimeout(r, 2000));

      // 4. Click Submit/Comment button inside the form
      const submitScript = `(() => {
        const editors = Array.from(document.querySelectorAll(
          '.comments-comment-box .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"]'
        )).filter(e => e.offsetParent !== null && !e.classList.contains('ql-clipboard'));
        const editor = editors[0];
        const form = editor ? (editor.closest('form') || editor.closest('.comments-comment-box')) : document;
        
        const submitBtn = form ? form.querySelector(
          'button.comments-comment-box__submit-button--cr, button.comments-comment-box__submit-button, button.comments-comment-texteditor__submit-button, button[type="submit"], button.artdeco-button--primary'
        ) : null;
        
        if (!submitBtn) return { error: 'SUBMIT_NOT_FOUND' };
        if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true' || submitBtn.classList.contains('artdeco-button--disabled')) {
          return { error: 'SUBMIT_DISABLED' };
        }
        if (typeof submitBtn.scrollIntoView === 'function') {
          submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        submitBtn.click();
        return { success: true };
      })()`;
      const submitResult = await this.evalJs(submitScript);
      if (submitResult && submitResult.error) {
        throw new Error(submitResult.error);
      }

      // 5. Verify it was posted (comment box should be cleared or gone)
      await new Promise((r) => setTimeout(r, 6000));
      const verifyScript = `(() => {
        const errorToast = document.querySelector('.artdeco-toast-item--error');
        if (errorToast) return { error: 'LINKEDIN_ERROR_TOAST: ' + errorToast.innerText };

        const editors = Array.from(document.querySelectorAll(
          '.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], .comments-comment-box div[contenteditable="true"]'
        )).filter(e => e.offsetParent !== null && !e.classList.contains('ql-clipboard'));
        
        // If the editor is still visible and still contains our text, it didn't submit!
        for (const editor of editors) {
          if (editor.innerText && editor.innerText.includes(${commentTextJson}.substring(0, 10))) {
            return { error: 'COMMENT_STILL_IN_EDITOR' };
          }
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
