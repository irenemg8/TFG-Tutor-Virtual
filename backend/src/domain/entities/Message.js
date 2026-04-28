"use strict";

const MessageMetadata = require("./MessageMetadata");

class Message {
  /**
   * Value object representing a single message in a conversation.
   * Replaces the embedded elements of conversacion[] in MongoDB.
   *
   * @param {object} props
   * @param {string}  [props.id]
   * @param {string}   props.interaccionId
   * @param {number}  [props.sequenceNum]
   * @param {string}   props.role           - "user" | "assistant"
   * @param {string}   props.content
   * @param {Date}    [props.timestamp]
   * @param {object}  [props.metadata]
   */
  constructor(props) {
    this.id = props.id || null;
    this.interaccionId = props.interaccionId;
    this.sequenceNum = props.sequenceNum ?? null;
    this.role = props.role;
    this.content = props.content;
    this.timestamp = props.timestamp || new Date();
    this.metadata = props.metadata ? new MessageMetadata(props.metadata) : null;
  }

  isUser() {
    return this.role === "user";
  }

  isAssistant() {
    return this.role === "assistant";
  }

  toOllamaFormat() {
    return { role: this.role, content: this.content };
  }

  /** Legacy Mongo JSON shape for frontend compat (conversacion[] items). */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      metadata: this.metadata,
    };
  }
}

module.exports = Message;
