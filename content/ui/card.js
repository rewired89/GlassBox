/**
 * GlassBox Context Card
 * Renders expandable context cards below flagged content.
 */

import { recordCardInteraction } from '../../lib/storage.js';
import { escHTML } from '../../lib/utils.js';

let cardDatabase = null;

async function loadCards() {
  if (cardDatabase) return cardDatabase;
  try {
    const url = chrome.runtime.getURL('data/context-cards.json');
    const res = await fetch(url);
    const json = await res.json();
    cardDatabase = json.cards || [];
  } catch (err) {
    console.warn('[GlassBox] Failed to load context cards:', err);
    cardDatabase = [];
  }
  return cardDatabase;
}

/**
 * Find a matching context card for the given text.
 * Returns the first card whose trigger phrases match.
 *
 * @param {string} text
 * @returns {Promise<Object|null>}
 */
export async function findMatchingCard(text) {
  const cards = await loadCards();
  const normalizedText = text.toLowerCase();

  for (const cardDef of cards) {
    const triggered = (cardDef.trigger_phrases || []).some((phrase) =>
      normalizedText.includes(phrase.toLowerCase())
    );
    if (triggered) return cardDef;
  }

  return null;
}

/**
 * Find all matching context cards for the given text.
 *
 * @param {string} text
 * @returns {Promise<Object[]>}
 */
export async function findAllMatchingCards(text) {
  const cards = await loadCards();
  const normalizedText = text.toLowerCase();

  return cards.filter((cardDef) =>
    (cardDef.trigger_phrases || []).some((phrase) =>
      normalizedText.includes(phrase.toLowerCase())
    )
  );
}

/**
 * Render a context card element.
 *
 * @param {Object} cardDef - Card definition from context-cards.json
 * @returns {HTMLElement}
 */
export function renderContextCard(cardDef) {
  const { id, card } = cardDef;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-glassbox', 'context-card');
  wrapper.setAttribute('data-card-id', id);
  wrapper.className = 'gb-card';

  // Timeline HTML
  const timelineHTML = (card.timeline || [])
    .map(
      (item) => `
      <div class="gb-card__timeline-item">
        <div class="gb-card__timeline-date">${escHTML(item.date)}</div>
        <div class="gb-card__timeline-event">${escHTML(item.event)}</div>
      </div>`
    )
    .join('');

  // Sources
  const sourcesHTML = card.sources && card.sources.length > 0
    ? `<div class="gb-card__sources">
        <div class="gb-card__sources-label">Sources</div>
        <ul class="gb-card__source-list">
          ${card.sources.map((s) => `<li class="gb-card__source-item">${escHTML(s)}</li>`).join('')}
        </ul>
      </div>`
    : '';

  // Rephrase suggestions
  const rephraseHTML =
    cardDef.rephrase_suggestions && cardDef.rephrase_suggestions.length > 0
      ? `<div class="gb-card__rephrase">
          <div class="gb-card__rephrase-label">How to rephrase</div>
          ${cardDef.rephrase_suggestions
            .map((r) => `<div class="gb-card__rephrase-item">${escHTML(r)}</div>`)
            .join('')}
        </div>`
      : '';

  wrapper.innerHTML = `
    <button class="gb-card__trigger" aria-expanded="false">
      <span class="gb-card__trigger-icon">📌</span>
      <span class="gb-card__trigger-text">${escHTML(card.hook)}</span>
      <span class="gb-card__trigger-arrow">▼</span>
    </button>
    <div class="gb-card__body">
      <div class="gb-card__title">${escHTML(card.title)}</div>

      ${timelineHTML
        ? `<div class="gb-card__timeline">${timelineHTML}</div>`
        : ''}

      ${card.irony_highlight
        ? `<div class="gb-card__highlight">${escHTML(card.irony_highlight)}</div>`
        : ''}

      ${card.empathy_angle
        ? `<div class="gb-card__empathy">💭 ${escHTML(card.empathy_angle)}</div>`
        : ''}

      ${rephraseHTML}
      ${sourcesHTML}
    </div>
  `;

  // Toggle expand/collapse
  const trigger = wrapper.querySelector('.gb-card__trigger');
  const body = wrapper.querySelector('.gb-card__body');
  const arrow = wrapper.querySelector('.gb-card__trigger-arrow');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = wrapper.classList.contains('gb-card--expanded');

    if (isExpanded) {
      wrapper.classList.remove('gb-card--expanded');
      trigger.setAttribute('aria-expanded', 'false');
    } else {
      wrapper.classList.add('gb-card--expanded');
      trigger.setAttribute('aria-expanded', 'true');
      // Track interaction
      recordCardInteraction(id, 'expand').catch(() => {});
    }
  });

  // Track source clicks
  wrapper.querySelectorAll('.gb-card__source-item').forEach((item) => {
    item.addEventListener('click', () => {
      recordCardInteraction(id, 'source_click').catch(() => {});
    });
  });

  return wrapper;
}

/**
 * Inject context cards below a post element.
 * Appends cards to `containerEl`.
 *
 * @param {string} text - Post text to match against
 * @param {HTMLElement} containerEl - Where to inject cards
 * @returns {Promise<number>} Number of cards injected
 */
export async function injectContextCards(text, containerEl) {
  const matches = await findAllMatchingCards(text);
  if (matches.length === 0) return 0;

  for (const cardDef of matches.slice(0, 2)) { // Cap at 2 cards per post
    const cardEl = renderContextCard(cardDef);
    containerEl.appendChild(cardEl);
  }

  return matches.length;
}
