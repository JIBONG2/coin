/**
 * Discord Components v2 — JSON 페이로드
 * 전송 시 flags에 IS_COMPONENTS_V2(32768) 필요
 */

const COMPONENT_TYPE = {
  ActionRow: 1,
  Button: 2,
  TextDisplay: 10,
  Section: 9,
  Container: 17,
  MediaGallery: 12,
  Separator: 7,
};

const BUTTON_STYLE = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
};

const IS_COMPONENTS_V2 = 32768;
const SELECT_MENU_STRING = 3;

function textDisplay(content) {
  return {
    type: COMPONENT_TYPE.TextDisplay,
    content: String(content || '').slice(0, 4000),
  };
}

function section(textContents, accessory) {
  const components = (Array.isArray(textContents) ? textContents : [textContents])
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => textDisplay(c));
  if (components.length === 0) components.push(textDisplay(' '));
  if (!accessory) return components;
  if (accessory.custom_id == null) return components;
  const out = { type: COMPONENT_TYPE.Section, components };
  out.accessory = {
    type: COMPONENT_TYPE.Button,
    style: accessory.style ?? BUTTON_STYLE.Secondary,
    custom_id: String(accessory.custom_id),
    label: String(accessory.label || '').slice(0, 80),
  };
  if (accessory.emoji) out.accessory.emoji = { name: String(accessory.emoji) };
  return out;
}

function actionRow(buttons) {
  const components = (buttons || []).map((b) => {
    const btn = {
      type: COMPONENT_TYPE.Button,
      style: b.style ?? BUTTON_STYLE.Secondary,
      label: String(b.label || '').slice(0, 80),
    };
    if (b.url) btn.url = b.url;
    else if (b.custom_id) btn.custom_id = String(b.custom_id);
    if (b.emoji) btn.emoji = typeof b.emoji === 'string' ? { name: b.emoji } : b.emoji;
    return btn;
  });
  return { type: COMPONENT_TYPE.ActionRow, components };
}

/** 구분선·여백 (type 7) — Container(17) 자식으로는 API 비허용. 텍스트로 대체할 것 */
function separator(opts) {
  const o = opts || {};
  const out = { type: COMPONENT_TYPE.Separator };
  if (typeof o.divider === 'boolean') out.divider = o.divider;
  if (o.spacing === 1 || o.spacing === 2) out.spacing = o.spacing;
  return out;
}

/** 큰 배너 이미지 (type 12) */
function mediaGallery(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => u && String(u).trim()).slice(0, 10);
  const items = list.map((url) => ({ media: { url: String(url).trim() } }));
  return { type: COMPONENT_TYPE.MediaGallery, items };
}

function container(children, accentColor) {
  const list = (Array.isArray(children) ? children : [children]).filter(Boolean).flat();
  const out = { type: COMPONENT_TYPE.Container, components: list };
  if (accentColor != null) out.accent_color = Number(accentColor);
  return out;
}

function stringSelectRow(customId, placeholder, options) {
  return {
    type: COMPONENT_TYPE.ActionRow,
    components: [
      {
        type: SELECT_MENU_STRING,
        custom_id: String(customId),
        placeholder: String(placeholder || '선택').slice(0, 150),
        options: (options || []).slice(0, 25).map((o) => ({
          label: String(o.label || o.value || '').slice(0, 100),
          value: String(o.value || o.label || '').slice(0, 100),
          description: o.description ? String(o.description).slice(0, 100) : undefined,
        })),
      },
    ],
  };
}

function v2Payload(components) {
  return {
    components: components.filter(Boolean).flat(),
    flags: IS_COMPONENTS_V2,
  };
}

module.exports = {
  IS_COMPONENTS_V2,
  COMPONENT_TYPE,
  BUTTON_STYLE,
  textDisplay,
  section,
  actionRow,
  separator,
  mediaGallery,
  container,
  stringSelectRow,
  v2Payload,
};
