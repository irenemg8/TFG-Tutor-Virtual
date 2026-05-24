"use strict";

/**
 * Role definitions and permission hierarchy.
 *
 * alumno:   Read own data, chat, view exercises
 * profesor: Everything alumno + read any student's data + exercise CRUD + export
 * admin:    Everything profesor + user CRUD
 */
const ROLES = {
  ALUMNO: "alumno",
  PROFESOR: "profesor",
  ADMIN: "admin",
};

const ROLE_HIERARCHY = {
  alumno: 0,
  profesor: 1,
  admin: 2,
};

function hasMinRole(userRole, requiredRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[requiredRole] || 0);
}

module.exports = { ROLES, ROLE_HIERARCHY, hasMinRole };
