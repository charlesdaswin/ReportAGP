function toggleSidebar() { 
  document.getElementById('sidebar').classList.toggle('collapsed'); 
}

function toggleSubmenu(submenuId, element) {
  const submenu = document.getElementById(submenuId);
  const arrow = element.querySelector('.arrow-icon');
  if (submenu.classList.contains('open')) {
    submenu.classList.remove('open');
    if (arrow) arrow.classList.remove('rotate');
  } else {
    submenu.classList.add('open');
    if (arrow) arrow.classList.add('rotate');
  }
}