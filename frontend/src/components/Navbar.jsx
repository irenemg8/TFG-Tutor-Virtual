import { Link, useLocation } from 'react-router-dom';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
} from '@headlessui/react';
import {
  Bars3Icon,
  XMarkIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  ChatBubbleLeftRightIcon,
  ChartBarIcon,
  BookOpenIcon,
} from '@heroicons/react/24/outline';

import logoTutor from "../assets/logotutor.png";


const navigation = [
  { name: 'Inicio', to: '/home', icon: HomeIcon },
  { name: 'Ejercicios', to: '/ejercicios', icon: BookOpenIcon },
  { name: 'Chat', to: '/interacciones', icon: ChatBubbleLeftRightIcon },
  { name: 'Progreso', to: '/dashboard', icon: ChartBarIcon },
];

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function Navbar() {
  const location = useLocation();

  return (
    <Disclosure as="nav" className="navbar">
      {({ open }) => (
        <>
          <div className="navbar-container">
            <div className="navbar-inner">
              <div className="navbar-logo">
                <img
                  src={logoTutor}
                  alt="Logo"
                  className="logo-img"
                />
                {/* <img className="logo-img" src="/logo.png"/> */}
                <span className="logo-text">Tutor Virtual</span>
              </div>

              <div className="navbar-toggle sm:hidden">
                <DisclosureButton className="btn-toggle">
                  <span className="sr-only">Abrir menú</span>
                  {open ? (
                    <XMarkIcon className="icon-toggle" aria-hidden="true" />
                  ) : (
                    <Bars3Icon className="icon-toggle" aria-hidden="true" />
                  )}
                </DisclosureButton>
              </div>

              <div className="navbar-menu hidden sm:block ml-auto">
                <div className="navbar-links">
                  {navigation.map((item) => {
                    const isActive = location.pathname === item.to;
                    return (
                      <Link
                        key={item.name}
                        to={item.to}
                        className={classNames(
                          'nav-item',
                          isActive ? 'nav-item-active' : 'nav-item-inactive'
                        )}
                      >
                        <item.icon
                          className={classNames(
                            'nav-icon',
                            isActive ? 'nav-icon-active' : 'nav-icon-inactive'
                          )}
                        />
                        <span className="nav-tooltip">{item.name}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <DisclosurePanel className="navbar-panel sm:hidden">
            {navigation.map((item) => {
              const isActive = location.pathname === item.to;
              return (
                <Link
                  key={item.name}
                  to={item.to}
                  className={classNames(
                    'nav-mobile-item',
                    isActive ? 'text-rojo' : 'text-black hover:text-rojo'
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );

}
