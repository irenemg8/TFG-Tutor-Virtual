"use strict";

class Usuario {
  /**
   * @param {object} props
   * @param {string}   props.id
   * @param {string}   props.upvLogin
   * @param {string}  [props.email]
   * @param {string}  [props.firstName]
   * @param {string}  [props.lastName]
   * @param {string}  [props.nationalId]
   * @param {string[]} [props.groups]
   * @param {string}  [props.role]
   * @param {Date}    [props.lastLoginAt]
   * @param {Date}    [props.createdAt]
   * @param {Date}    [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id;
    this.upvLogin = props.upvLogin;
    this.email = props.email || "";
    this.firstName = props.firstName || "";
    this.lastName = props.lastName || "";
    this.nationalId = props.nationalId || "";
    this.groups = props.groups || [];
    this.role = props.role || "alumno";
    this.lastLoginAt = props.lastLoginAt || null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  isStudent() {
    return this.role === "alumno";
  }

  isTeacher() {
    return this.role === "profesor";
  }

  isAdmin() {
    return this.role === "admin";
  }

  hasRole(role) {
    return this.role === role;
  }

  /** Legacy Mongo JSON shape for frontend compat. */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      upvLogin: this.upvLogin,
      email: this.email,
      nombre: this.firstName,
      apellidos: this.lastName,
      dni: this.nationalId,
      grupos: this.groups,
      rol: this.role,
      lastLoginAt: this.lastLoginAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Usuario;
